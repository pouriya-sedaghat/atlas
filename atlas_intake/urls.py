from django.contrib.auth.views import LoginView, LogoutView
from django.urls import path, reverse_lazy

from . import views

app_name = "atlas_intake"

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path(
        "login/",
        LoginView.as_view(
            template_name="atlas_intake/login.html",
            next_page=reverse_lazy("atlas_intake:dashboard"),
        ),
        name="login",
    ),
    path(
        "logout/",
        LogoutView.as_view(next_page=reverse_lazy("atlas_intake:login")),
        name="logout",
    ),
    path("selection/", views.save_selection, name="save_selection"),
    path("schedule/", views.schedule, name="schedule"),
    path("mode/manual/", views.manual_mode, name="manual_mode"),
    path("catalog/refresh/", views.refresh_catalog, name="refresh_catalog"),
    path("runs/launch/", views.launch, name="launch"),
    path("runs/<uuid:run_id>/", views.run_detail, name="run_detail"),
    path("runs/<uuid:run_id>/files/<int:artifact_id>/retry/", views.retry, name="retry"),
    path("runs/<uuid:run_id>/files/<int:artifact_id>/boundary/", views.boundary, name="boundary"),
]
