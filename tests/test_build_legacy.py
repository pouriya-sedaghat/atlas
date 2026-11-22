from unittest import TestCase

class LegacyPreflightTests(TestCase):
    def scopes(self):
        return [{'name':str(i),'run_cap':2*1024**3,'intake_outstanding':0,'verification_outstanding':0,
                 'verifier_cap':20*1024**3 if i==2 else 0,'busy':False,'identity':{'mode':'manual'}} for i in range(5)]

    def test_five_scopes_and_one_verifier_have_allocation_margin(self):
        from atlas_build.legacy import evaluate
        result=evaluate(self.scopes(),{'containers':16})
        self.assertTrue(result['quiescent'])
        self.assertEqual(result['headroom_bytes'],33*1024**3)

    def test_busy_or_larger_outstanding_legacy_scope_is_explicit(self):
        from atlas_build.legacy import evaluate
        scopes=self.scopes();scopes[0]['busy']=True;scopes[0]['intake_outstanding']=4*1024**3
        result=evaluate(scopes,{'containers':16})
        self.assertFalse(result['quiescent'])
        self.assertGreater(result['headroom_bytes'],33*1024**3)
        first=evaluate(self.scopes(),{'containers':16})
        changed=evaluate(self.scopes(),{'containers':17})
        self.assertNotEqual(first['inventory_digest'],changed['inventory_digest'])
