import { describe, expect, it } from 'vitest';
import { parseRecordLink } from './slack-record-link';

const WEB = 'https://app.example.com';
const WS = '3448c14b-70f3-41bc-9188-839029be9f7e';
const DB = '3f743dcd-d5ca-47c0-a676-72f40934119b';
const REC = 'de6e8cd7-c0b7-4e76-95ab-18c6a34c1cf9';

describe('parseRecordLink (ticket #1379)', () => {
  it('reads a record link by number and by uuid, ignoring query, fragment and a trailing slash', () => {
    expect(parseRecordLink(`${WEB}/w/${WS}/d/${DB}/r/1379`, WEB)).toEqual({ workspaceId: WS, databaseId: DB, recordRef: '1379' });
    expect(parseRecordLink(`${WEB}/w/${WS}/d/${DB}/r/${REC}?comment=abc#top`, WEB)).toEqual({ workspaceId: WS, databaseId: DB, recordRef: REC });
    expect(parseRecordLink(`${WEB}/w/${WS}/d/${DB}/r/7/`, WEB)).toEqual({ workspaceId: WS, databaseId: DB, recordRef: '7' });
  });

  it('lower-cases ids so a pasted upper-case uuid still names the same record', () => {
    expect(parseRecordLink(`${WEB}/w/${WS.toUpperCase()}/d/${DB}/r/1`, WEB)?.workspaceId).toBe(WS);
  });

  it('refuses another host, another port, another scheme, and a look-alike host', () => {
    for (const host of ['https://evil.example.net', 'https://app.example.com:8443', 'http://app.example.com', 'https://app.example.com.evil.net', 'https://evil.net/https://app.example.com']) {
      expect(parseRecordLink(`${host}/w/${WS}/d/${DB}/r/1`, WEB), host).toBeNull();
    }
    expect(parseRecordLink(`https://user:pw@app.example.com/w/${WS}/d/${DB}/r/1`, WEB)).toBeNull();
  });

  it('refuses everything that is not exactly a record link', () => {
    for (const path of [
      `/w/${WS}`,
      `/w/${WS}/d/${DB}`,
      `/w/${WS}/d/${DB}/r/`,
      `/w/${WS}/d/${DB}/r/${REC}/extra`,
      `/w/${WS}/d/not-a-uuid/r/1`,
      `/w/not-a-uuid/d/${DB}/r/1`,
      `/w/${WS}/doc/${DB}`,
      `/w/${WS}/d/${DB}/r/007`,
      `/w/${WS}/d/${DB}/r/1e3`,
      `/w/${WS}/d/${DB}/r/-1`,
      `/w/${WS}/d/${DB}/r/99999999999`,
      `/w/${WS}/d/${DB}/r/..%2Fx`,
      `/x/w/${WS}/d/${DB}/r/1`,
    ]) {
      expect(parseRecordLink(`${WEB}${path}`, WEB), path).toBeNull();
    }
  });

  it('never throws on junk', () => {
    for (const junk of ['', 'not a url', '//', 'javascript:alert(1)', 'https://', ':::']) {
      expect(parseRecordLink(junk, WEB), junk).toBeNull();
    }
    expect(parseRecordLink(`${WEB}/w/${WS}/d/${DB}/r/1`, 'not a url')).toBeNull();
  });
});
