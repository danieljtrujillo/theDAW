/**
 * lyricDocumentsClient.ts — the `/api/lyricanalysis/documents` surface: lyrics
 * that belong to no song, written in the LYRIC tab.
 *
 * The types mirror the `LyricDocument` / `LyricDocumentSummary` models in
 * backend/modules/lyricanalysis/schema.py, so the field names stay snake_case.
 * Ids are minted by the server (`lyricdoc_` + 32 hex) and are the only shape it
 * accepts — nothing here ever builds one.
 *
 * The analysis of a document is fetched through `lyricAnalysisClient` with the
 * document id in place of an entry id: the backend serves both kinds of
 * subject on the same routes, which is what lets the SING tab's analysis pane
 * read a notebook page unchanged.
 */

import { delJson, getJson, postJson, putJson } from '../../../lib/apiJson';

export interface LyricDocument {
  version: number;
  id: string;
  title: string;
  text: string;
  language: string;
  /** The library entry this draft was saved into; '' while it belongs to none. */
  entry_id: string;
  created_at: number;
  updated_at: number;
}

export interface LyricDocumentSummary {
  id: string;
  title: string;
  updated_at: number;
  created_at: number;
  /** Lyric lines only — markers and blanks are not counted. */
  lines: number;
  words: number;
  /** null when the draft is attached to nothing. */
  entry_id: string | null;
  analyzed: boolean;
}

export interface CreateLyricDocumentBody {
  title?: string;
  text?: string;
  language?: string;
  entry_id?: string;
}

export interface UpdateLyricDocumentBody {
  title?: string;
  text?: string;
  language?: string;
  /** '' detaches the draft from its song. */
  entry_id?: string;
}

const enc = encodeURIComponent;
const ROOT = '/api/lyricanalysis/documents';

export const fetchLyricDocuments = async (): Promise<LyricDocumentSummary[]> =>
  (await getJson<{ documents: LyricDocumentSummary[] }>(ROOT)).documents;

export const fetchLyricDocument = (id: string): Promise<LyricDocument> =>
  getJson<LyricDocument>(`${ROOT}/${enc(id)}`);

export const createLyricDocument = (body: CreateLyricDocumentBody = {}): Promise<LyricDocument> =>
  postJson<LyricDocument>(ROOT, body);

export const updateLyricDocument = (id: string, body: UpdateLyricDocumentBody): Promise<LyricDocument> =>
  putJson<LyricDocument>(`${ROOT}/${enc(id)}`, body);

export const deleteLyricDocument = (id: string): Promise<{ ok: boolean }> =>
  delJson<{ ok: boolean }>(`${ROOT}/${enc(id)}`);

export const duplicateLyricDocument = (id: string): Promise<LyricDocument> =>
  postJson<LyricDocument>(`${ROOT}/${enc(id)}/duplicate`, {});

/** Record which song this draft became. `write_lyrics` also pushes the words
 *  into that entry's lyrics document server-side; the LYRIC tab does that half
 *  through `/api/lyrics` instead, so it goes through the same save path SING
 *  uses (line-diffed, timings carried over). */
export const attachLyricDocument = (
  id: string,
  entryId: string,
  writeLyrics = false,
): Promise<LyricDocument> =>
  postJson<LyricDocument>(`${ROOT}/${enc(id)}/attach`, {
    entry_id: entryId,
    write_lyrics: writeLyrics,
  });
