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
    activation_date = forms.DateField(
        label="Activation date",
        input_formats=["%Y-%m-%d"],
        widget=forms.DateInput(format="%Y-%m-%d", attrs={"type": "date"}),
    )
    activation_time = forms.TimeField(
        label="Activation time",
        input_formats=["%H:%M"],
        widget=forms.TimeInput(format="%H:%M", attrs={"type": "time"}),
    )
    activation_offset = forms.CharField(
        required=False,
        label="Activation UTC offset",
        max_length=6,
        widget=forms.TextInput(attrs={"placeholder": "-04:00", "spellcheck": "false"}),
    )
    expiry_date = forms.DateField(
        label="Expiry date",
        input_formats=["%Y-%m-%d"],
        widget=forms.DateInput(format="%Y-%m-%d", attrs={"type": "date"}),
    )
    expiry_time = forms.TimeField(
        label="Expiry time",
        input_formats=["%H:%M"],
        widget=forms.TimeInput(format="%H:%M", attrs={"type": "time"}),
    )
    expiry_offset = forms.CharField(
        required=False,
        label="Expiry UTC offset",
        max_length=6,
        widget=forms.TextInput(attrs={"placeholder": "-05:00", "spellcheck": "false"}),
    )
    zone = forms.CharField(
        label="IANA time zone",
        max_length=128,
        widget=forms.TextInput(attrs={"placeholder": "Asia/Tehran", "spellcheck": "false"}),
    )
    interval_minutes = forms.IntegerField(
        label="Elapsed interval in minutes",
        min_value=1,
        initial=1440,
        help_text="1440 minutes is 24 hours.",
    )


class LaunchForm(forms.Form):
    request_key = forms.UUIDField(widget=forms.HiddenInput)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not self.is_bound:
            self.initial["request_key"] = uuid.uuid4()
