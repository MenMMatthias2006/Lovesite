# Supabase setup for your love memory site

1. Create a Supabase project at https://supabase.com.
2. In SQL Editor, run:

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  title TEXT,
  date TEXT,
  location TEXT,
  location_lat TEXT,
  location_lng TEXT,
  location_place_id TEXT,
  text TEXT,
  images JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read" ON memories
  FOR SELECT USING (true);

CREATE POLICY "Allow anon insert" ON memories
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow anon update" ON memories
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon delete" ON memories
  FOR DELETE USING (true);

3. Open Settings > API and copy:
   - Project URL
   - anon public key
4. In Storage, create a public bucket named `memories`.
5. In Storage > Policies for the `memories` bucket, add these two policies:
   - `Allow public read`: `SELECT` using `(bucket_id = 'memories')`
   - `Allow anon upload`: `INSERT` with check `(bucket_id = 'memories')`
   If you prefer SQL, run:
   create policy "Allow public read" on storage.objects for select using (bucket_id = 'memories');
   create policy "Allow anon upload" on storage.objects for insert with check (bucket_id = 'memories');
6. Paste those values into config.js.
7. Reload the site.

The site will use Supabase when credentials are present, and fall back to IndexedDB/localStorage automatically when they are not.
