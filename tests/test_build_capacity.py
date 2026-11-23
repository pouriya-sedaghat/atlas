from unittest import TestCase
from django.core.exceptions import ValidationError

class BuildCapacityTests(TestCase):
    def test_reservations_and_legacy_headroom_preserve_free_floor(self):
        from atlas_build.capacity import storage_check,GIB
        with self.assertRaises(ValidationError):storage_check(free=50*GIB,used=0,outstanding=0,legacy=33*GIB,new=12*GIB)
        self.assertTrue(storage_check(free=80*GIB,used=0,outstanding=0,legacy=33*GIB,new=12*GIB))
        with self.assertRaises(ValidationError):storage_check(free=80*GIB,used=0,outstanding=20*GIB,legacy=33*GIB,new=12*GIB)

    def test_root_budget_charges_retained_ready_failure_and_new_execution(self):
        from atlas_build.capacity import storage_check,GIB
        with self.assertRaises(ValidationError):storage_check(free=200*GIB,used=25*GIB,outstanding=0,legacy=33*GIB,new=12*GIB)
        self.assertTrue(storage_check(free=200*GIB,used=12*GIB,outstanding=0,legacy=33*GIB,new=12*GIB))

    def test_other_plane_commitment_uses_free_floor_without_double_charging_build_root(self):
        from atlas_build.capacity import storage_check,GIB
        self.assertTrue(storage_check(free=200*GIB,used=12*GIB,outstanding=30*GIB,
                      root_outstanding=0,legacy=33*GIB,new=12*GIB))

    def test_growth_stops_with_rollback_margin_and_retained_database_ceiling(self):
        from atlas_build.capacity import metric_budget,GIB
        metrics={'heap_toast':0,'indexes':0,'wal':0,'temp':0,'root_used':0,'client_bytes':0,'bundle_logs':0,'database_bytes':0,'wal_generated':0}
        self.assertTrue(metric_budget(metrics))
        for field,value in [('heap_toast',4*GIB-1),('indexes',2*GIB-1),('wal',2*GIB-1),
                            ('temp',GIB-1),('database_bytes',6*GIB-1),('root_used',32*GIB+1),
                            ('client_bytes',GIB+1),('bundle_logs',64*1024**2+1),('wal_generated',-1)]:
            with self.subTest(field=field),self.assertRaises(ValidationError):metric_budget({**metrics,field:value})
