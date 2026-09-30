// Wire types for render lineage (F23). One file, imported by the render side
// (which reports what a render was made from) and by the library inspector
// (which shows where an entry was used). They mirror the backend contract at
// /api/lineage exactly; change both sides together.

export type LineageRenderKind = 'full' | 'range' | 'stems' | 'clips'

export type LineageContributionRole = 'audio' | 'midi' | 'stem'

/** One source that was actually audible in a render. */
export type LineageContribution = {
  library_entry_id: string
  clip_id: string
  track_id: string
  /** Where on the project timeline this source sounded, in seconds. */
  start_sec: number
  end_sec: number
  /** Offset into the source file at start_sec, in seconds. */
  source_offset_sec: number
  role: LineageContributionRole
}

export type LineageOutput = {
  library_entry_id: string | null
  path: string | null
  kind: LineageRenderKind
  start_sec: number | null
  end_sec: number | null
}

/** Body of POST /api/lineage/renders, and the record GET /render/{id} returns. */
export type LineageRenderRecord = {
  render_id: string
  project_id: string
  project_name: string
  /** ISO-8601, UTC. */
  created_at: string
  output: LineageOutput
  contributions: LineageContribution[]
}

export type LineageUsedInProject = {
  project_id: string
  project_name: string
  renders: number
  last_render_at: string
}

export type LineageUsedInRender = {
  render_id: string
  created_at: string
  kind: LineageRenderKind
  project_id: string
  project_name: string
  output_entry_id: string | null
  output_path: string | null
}

/** GET /api/lineage/used-in/{library_entry_id} */
export type LineageUsedIn = {
  entry_id: string
  projects: LineageUsedInProject[]
  renders: LineageUsedInRender[]
}

/** GET /api/lineage/sources/{library_entry_id} */
export type LineageSources = {
  entry_id: string
  render: LineageRenderRecord | null
}
