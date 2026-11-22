"""Explicit semantic JSON -> bytea copy. No implicit cast; restore-only rollback.

Run against a backed-up control database. New NUL-bearing reports cannot be
represented by the old JSONB schema, so this migration is intentionally
irreversible. Source/manifest/output files and registered digests are untouched.
"""
import json
from django.db import migrations, models
import atlas_verification.fields


def copy_reports(apps, schema_editor):
    for model_name, fields in [('VerificationAttempt', ('summary','progress')),
                               ('VerificationExecution', ('report',))]:
        model=apps.get_model('atlas_verification',model_name)
        for row in model.objects.only('pk',*fields).iterator(chunk_size=100):
            updates={field+'_bytes':json.dumps(getattr(row,field),ensure_ascii=False,
                       sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')
                     for field in fields}
            model.objects.filter(pk=row.pk).update(**updates)


class Migration(migrations.Migration):
    dependencies=[('atlas_verification','0001_initial')]
    operations=[
        migrations.AddField('verificationattempt','summary_bytes',models.BinaryField(null=True)),
        migrations.AddField('verificationattempt','progress_bytes',models.BinaryField(null=True)),
        migrations.AddField('verificationexecution','report_bytes',models.BinaryField(null=True)),
        migrations.RunPython(copy_reports, migrations.RunPython.noop),
        migrations.RemoveField('verificationattempt','summary'),
        migrations.RemoveField('verificationattempt','progress'),
        migrations.RemoveField('verificationexecution','report'),
        migrations.RenameField('verificationattempt','summary_bytes','summary'),
        migrations.RenameField('verificationattempt','progress_bytes','progress'),
        migrations.RenameField('verificationexecution','report_bytes','report'),
        migrations.AlterField('verificationattempt','summary',atlas_verification.fields.LosslessJSONField(default=dict)),
        migrations.AlterField('verificationattempt','progress',atlas_verification.fields.LosslessJSONField(default=dict)),
        migrations.AlterField('verificationexecution','report',atlas_verification.fields.LosslessJSONField(default=dict)),
        # First operation encountered on reverse: fail before changing any data.
        migrations.RunPython(migrations.RunPython.noop),
    ]
