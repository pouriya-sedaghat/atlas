from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import TestCase,Client,override_settings
from django.urls import reverse

@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildViewTests(TestCase):
    def setUp(self):
        self.user=get_user_model().objects.create_user('fixture-operator')
    def test_progress_requires_operator_permission_and_mutations_require_csrf(self):
        url=reverse('build:index')
        self.assertEqual(self.client.get(url).status_code,302)
        self.client.force_login(self.user);self.assertEqual(self.client.get(url).status_code,403)
        self.user.user_permissions.add(Permission.objects.get(codename='operate'))
        self.assertEqual(self.client.get(url).status_code,200)
        self.assertContains(self.client.get(url),'Live admission is disabled')
        secured=Client(enforce_csrf_checks=True);secured.force_login(self.user)
        from uuid import uuid4
        target=reverse('build:action',args=[uuid4(),'retry'])
        self.assertEqual(secured.post(target,{'reason':'test'}).status_code,403)
        self.assertEqual(self.client.get(target).status_code,405)
