// Local workerd harness only: never export inspection routes in production.
import { IntakeBuffer as BaseIntake } from '../../src/intake-buffer.js';
import { MediaJob, serveMedia } from '../../src/media-jobs.js';
export { MediaJob };
export class IntakeBuffer extends BaseIntake {
 async fetch(request) {
  if(new URL(request.url).pathname==='/inspect') return Response.json(await this.state.storage.get('buf') || []);
  return super.fetch(request);
 }
}
export default {async fetch(request,env) {
 if(new URL(request.url).pathname==='/internal/media')return serveMedia(request,env);
 return env.INTAKE.get(env.INTAKE.idFromName('42')).fetch(request);
}};
