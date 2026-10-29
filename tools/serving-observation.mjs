// A delayed event loop may process a response before its overdue abort callback.
// Preserve the wire result, but never renew health from a late or changed response.
export function classifyServingObservation(row,elapsedMs){
  if(!Number.isFinite(elapsedMs)||elapsedMs<0)throw Error('invalid observation duration');
  const result={...row,ms:Math.round(elapsedMs*1000)/1000};
  if([200,204].includes(row.status)&&(elapsedMs>5000||row.bytes_match_first_sample===false||row.matches_first_observation===false)){
    result.wire_status=row.status;result.status=0;
    result.error=elapsedMs>5000?'ElapsedDeadlineExceeded':'ContentChanged';
  }
  return result;
}
