from django.contrib import messages
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db import transaction
from django.http import HttpResponseBadRequest
from django.shortcuts import get_object_or_404,redirect,render
from django.utils import timezone
from django.views.decorators.http import require_safe,require_POST
from atlas_intake.views import operator
from atlas_intake.control import lock_control,audit
from atlas_verification.diagnostics import diagnostic_json,diagnostic_text
from .control import fixture_guard
from .models import BuildIntent,BuildExecution,DDLOperation
from .provision import operation_marker
from .worker import cancel_build,retry_build,resume_publication

@operator
@require_safe
def index(request):
    page=Paginator(BuildIntent.objects.select_related('receipt','profile').order_by('-request_order'),30).get_page(request.GET.get('page'))
    return render(request,'atlas_build/index.html',{'page':page})

@operator
@require_safe
def detail(request,intent_id):
    intent=get_object_or_404(BuildIntent.objects.select_related('receipt','profile'),pk=intent_id)
    executions=[]
    for execution in intent.executions.select_related('candidate').order_by('-generation')[:30]:
        executions.append({'record':execution,'candidate':execution.candidate,'progress':diagnostic_json(execution.progress),
                            'report':diagnostic_json(execution.report),'identity':diagnostic_json(execution.candidate.identity)})
    return render(request,'atlas_build/detail.html',{'intent':intent,'executions':executions,'coverage':diagnostic_json(intent.coverage)})

@operator
@require_POST
def action(request,intent_id,action):
    intent=get_object_or_404(BuildIntent,pk=intent_id)
    actor=request.user.get_username();reason=request.POST.get('reason','').strip()
    if not reason or len(reason)>2000:return HttpResponseBadRequest('A reason of at most 2,000 characters is required.')
    try:
        fixture_guard()
        if action=='cancel':cancel_build(intent.pk,actor,reason)
        elif action=='retry':retry_build(intent.pk,actor,reason)
        elif action=='resume':resume_publication(intent.pk,actor,reason)
        elif action in ['cleanup','revalidate']:
            with transaction.atomic():
                lock_control();execution=intent.executions.select_for_update(of=('self',)).select_related('candidate').order_by('-generation').first()
                if not execution:raise ValidationError('This intent has no execution.')
                candidate=execution.candidate
                if action=='revalidate':
                    if candidate.status!='READY' or candidate.revoked_at:raise ValidationError('Only current READY evidence can be revalidated.')
                    execution.progress={**execution.progress,'revalidate_requested':timezone.now().isoformat()};execution.save(update_fields=['progress'])
                    audit('build.revalidate_requested',actor,candidate=str(candidate.pk),reason=diagnostic_text(reason))
                else:
                    if candidate.ready_at or execution.status in ['running','prepared']:raise ValidationError('Only stopped never-READY resources can be cleaned.')
                    op,_=DDLOperation.objects.get_or_create(candidate=candidate,operation='drop')
                    previous=op.intended
                    op.intended={'marker':operation_marker(candidate,execution),'explicit':True,'actor':actor,'reason':diagnostic_text(reason)}
                    op.status='intended';op.save(update_fields=['intended','status'])
                    audit('build.cleanup_queued',actor,candidate=str(candidate.pk),previous=previous,reason=diagnostic_text(reason))
        else:return HttpResponseBadRequest('Unknown build action.')
    except ValidationError as error:messages.error(request,diagnostic_text(error))
    else:messages.success(request,'Action recorded. The fixture builder will process it.')
    return redirect('build:detail',intent_id=intent.pk)
