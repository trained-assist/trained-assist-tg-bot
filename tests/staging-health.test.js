import {it,expect,vi} from 'vitest';
import {checkHealth} from '../scripts/staging/check-health.mjs';
const sha='a'.repeat(40);
it('validates status and revision from one response despite propagation errors',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce({ok:false,status:500}).mockResolvedValueOnce({ok:false,status:404})
  .mockResolvedValueOnce({ok:true,json:async()=>({buildSha:sha})}).mockResolvedValue({ok:false,status:404});
 expect(await checkHealth('https://preview/health',sha,{fetchImpl,sleep:async()=>{}})).toEqual({buildSha:sha});
 expect(fetchImpl).toHaveBeenCalledTimes(3);
});
it('wrong revision, HTTP errors and malformed data exhaust the bounded gate',async()=>{
 for(const response of [{ok:true,json:async()=>({buildSha:'b'.repeat(40)})},{ok:false,status:404},{ok:true,json:async()=>{throw Error('invalid JSON')}}]){
  const fetchImpl=vi.fn().mockResolvedValue(response);
  await expect(checkHealth('https://preview/health',sha,{fetchImpl,sleep:async()=>{},attempts:2})).rejects.toThrow('Staging health failed');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
 }
});
it('network failure can recover but missing revision never invokes network',async()=>{
 const fetchImpl=vi.fn().mockRejectedValueOnce(Error('network')).mockResolvedValue({ok:true,json:async()=>({buildSha:sha})});
 await checkHealth('https://preview/health',sha,{fetchImpl,sleep:async()=>{}});
 expect(fetchImpl).toHaveBeenCalledTimes(2);
 await expect(checkHealth('https://preview/health','',{fetchImpl})).rejects.toThrow('Exact revision required');
 expect(fetchImpl).toHaveBeenCalledTimes(2);
});
