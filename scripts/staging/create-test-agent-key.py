import json, secrets, subprocess
from pathlib import Path
key=secrets.token_urlsafe(32)
Path('.dev.vars.staging-agent').write_text('TEST_AGENT_SECRET='+key+'\n')
print('Local test key written to ignored .dev.vars.staging-agent; value not displayed.')
