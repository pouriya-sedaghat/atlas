from datetime import timedelta

from .models import Schedule


MINUTE = timedelta(minutes=1)
GRACE = timedelta(hours=24)
BLOCKER_LABELS = {
    "retrieval_slot_busy": "The retrieval slot is busy.",
    "catalog_unavailable": "A validated catalog is unavailable.",
}


def occurrence_count(schedule):
    if schedule.kind == Schedule.Kind.LEGACY:
        return 1
    interval = MINUTE * schedule.interval_minutes
    return (schedule.expires_at - schedule.activation_at - timedelta.resolution) // interval


def planned_instant(schedule, index):
    if schedule.kind == Schedule.Kind.LEGACY:
        return schedule.due_at
    return schedule.activation_at + MINUTE * (schedule.interval_minutes * index)


def closed_through(schedule, now):
    if schedule.kind == Schedule.Kind.LEGACY:
        return int(now - schedule.due_at >= GRACE)
    interval = MINUTE * schedule.interval_minutes
    latest = min(occurrence_count(schedule), (now - schedule.activation_at) // interval)
    if latest < 1:
        return 0
    due = planned_instant(schedule, latest)
    tolerance = min(interval, GRACE, schedule.expires_at - due)
    return latest if now - due >= tolerance else latest - 1


def schedule_preview(schedule, now):
    """Project the current schedule state without waiting for the worker to poll."""
    result = {"state": schedule.get_status_display(), "waiting_at": None, "next_due_at": None, "blocker": ""}
    if schedule.status != Schedule.Status.PENDING:
        return result
    recurring = schedule.kind == Schedule.Kind.RECURRING
    if recurring and now >= schedule.expires_at:
        return {**result, "state": Schedule.Status.EXPIRED.label}
    closed = closed_through(schedule, now)
    if not recurring and closed:
        return {**result, "state": Schedule.Status.MISSED.label}

    count = occurrence_count(schedule)
    index = max(schedule.last_resolved, closed) + 1
    result["state"] = "Waiting for activation" if recurring and now < schedule.activation_at else "Active"
    if index <= count:
        due = planned_instant(schedule, index)
        if due <= now:
            result["state"] = "Waiting"
            result["waiting_at"] = due
            if index == schedule.last_resolved + 1:
                result["blocker"] = BLOCKER_LABELS.get(schedule.blocked_reason, "")
            index += 1
        if index <= count:
            result["next_due_at"] = planned_instant(schedule, index)
    return result
