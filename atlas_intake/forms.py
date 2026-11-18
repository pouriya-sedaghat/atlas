import uuid

from django import forms
from django.core import signing


class SelectionForm(forms.Form):
    selection_token = forms.CharField(widget=forms.HiddenInput)
    pbf_ids = forms.MultipleChoiceField(required=False)
    remove_unavailable = forms.MultipleChoiceField(required=False)

    salt = "atlas-intake-selection"

    def __init__(self, *args, catalog_id, regions, selection, **kwargs):
        super().__init__(*args, **kwargs)
        self.snapshot = {"catalog": catalog_id, "selection": selection}
        self.initial["selection_token"] = signing.dumps(self.snapshot, salt=self.salt)
        available = {region["id"] for region in regions if region.get("pbf_url")}
        self.unavailable = sorted(set(selection) - available)
        self.fields["pbf_ids"].choices = [(region_id, region_id) for region_id in sorted(available)]
        self.fields["remove_unavailable"].choices = [(region_id, region_id) for region_id in self.unavailable]

    def clean_selection_token(self):
        try:
            snapshot = signing.loads(self.cleaned_data["selection_token"], salt=self.salt)
        except signing.BadSignature as exc:
            raise forms.ValidationError("Reload the panel to edit the selection.") from exc
        if snapshot != self.snapshot:
            raise forms.ValidationError("The catalog or saved selection changed. Review the current selection and try again.")
        return snapshot

    def selected_ids(self):
        remaining = set(self.unavailable) - set(self.cleaned_data["remove_unavailable"])
        return sorted(remaining | set(self.cleaned_data["pbf_ids"]))


class ScheduleForm(forms.Form):
    wall_date = forms.DateField(
        label="Local date",
        input_formats=["%Y-%m-%d"],
        widget=forms.DateInput(format="%Y-%m-%d", attrs={"type": "date"}),
    )
    wall_time = forms.TimeField(
        label="Local time",
        input_formats=["%H:%M"],
        widget=forms.TimeInput(format="%H:%M", attrs={"type": "time"}),
    )
    zone = forms.CharField(
        label="IANA time zone",
        max_length=128,
        widget=forms.TextInput(attrs={"placeholder": "Asia/Tehran", "spellcheck": "false"}),
    )
    offset = forms.CharField(
        required=False,
        label="UTC offset for an ambiguous time",
        max_length=6,
        widget=forms.TextInput(attrs={"placeholder": "−04:00", "spellcheck": "false"}),
        help_text="Enter a signed offset such as -04:00 if the local time occurs twice.",
    )


class LaunchForm(forms.Form):
    request_key = forms.UUIDField(widget=forms.HiddenInput)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not self.is_bound:
            self.initial["request_key"] = uuid.uuid4()
