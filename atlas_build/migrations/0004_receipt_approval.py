import django.db.models.deletion
from django.db import migrations,models
class Migration(migrations.Migration):
    dependencies=[('atlas_build','0003_one_active_slot')]
    operations=[migrations.AddField(model_name='buildreceipt',name='approval',field=models.ForeignKey(null=True,
        on_delete=django.db.models.deletion.PROTECT,related_name='+',to='atlas_build.shrinkapproval'))]
