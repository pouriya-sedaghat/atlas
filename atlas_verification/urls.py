from django.urls import path

from . import views

app_name = "verification"
urlpatterns = [
    path("", views.index, name="index"),
    path("runs/<uuid:run_id>/", views.run_detail, name="run"),
    path("runs/<uuid:run_id>/", views.run_detail, name="run_detail"),
    path("runs/<uuid:run_id>/request/", views.request_verification, name="request"),
    path("attempts/<uuid:attempt_id>/", views.attempt_detail, name="attempt_detail"),
    path("attempts/<uuid:attempt_id>/retry/", views.retry_verification, name="retry"),
    path("attempts/<uuid:attempt_id>/manifest/", views.manifest, name="manifest"),
    path("attempts/<uuid:attempt_id>/regions/<slug:region_key>/", views.region_manifest, name="region_manifest"),
]
