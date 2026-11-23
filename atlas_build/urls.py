from django.urls import path
from . import views
app_name='build'
urlpatterns=[path('',views.index,name='index'),path('intents/<uuid:intent_id>/',views.detail,name='detail'),
    path('intents/<uuid:intent_id>/<slug:action>/',views.action,name='action')]
