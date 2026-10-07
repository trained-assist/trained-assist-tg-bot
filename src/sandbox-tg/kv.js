export async function* kvEntries(kv, prefix) {
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const entry of page.keys) {
      const value = await kv.get(entry.name);
      if (value != null) yield { key: entry.name, value };
    }
    if (page.list_complete) return;
    if (!page.cursor || page.cursor === cursor) throw new Error('KV pagination did not advance');
    cursor = page.cursor;
  } while (true);
}
