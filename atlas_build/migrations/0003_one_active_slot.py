from django.db import migrations,models
class Migration(migrations.Migration):
    dependencies=[('atlas_build','0002_remove_buildprofile_last_ready_and_more')]
    operations=[migrations.RemoveConstraint(model_name='buildexecution',name='one_active_builder'),
        migrations.AddConstraint(model_name='buildexecution',constraint=models.UniqueConstraint(models.Value(1),
            condition=models.Q(status__in=['running','prepared']),name='one_active_build_execution'))]
