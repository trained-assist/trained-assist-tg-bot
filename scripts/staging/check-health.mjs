import { pathToFileURL } from 'node:url';
export async function checkHealth(url, sha, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), attempts = 12 } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Exact revision required');
  let error;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.buildSha !== sha) throw Error('Wrong staging revision');
      return body;
    } catch (failure) { error = failure; }
    if (attempt < attempts) await sleep(5000);
  }
  throw new Error(`Staging health failed: ${error?.message}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkHealth(process.argv[2], process.argv[3]).then(body => console.log(JSON.stringify(body))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
