import { describe, expect, it } from 'vitest';
import {
  ANNOUNCE_MARKER,
  AnnounceParseError,
  NoAnnounceError,
  fetchPrComments,
  isRemoteClientUrl,
  parseAnnounceBody,
  parsePrArg,
  resolveAnnounceFromComments,
  resolvePreviewTarget,
  selectAnnounceComment,
  type AnnounceComment,
} from './preview-target';

function announceComment(overrides: Partial<{ url: string; sha: string; vm: string; pr: number; extra: string }> = {}): string {
  const payload = {
    pr: overrides.pr ?? 20,
    sha: overrides.sha ?? 'a'.repeat(40),
    vm: overrides.vm ?? 'mog-pr-20',
    url: overrides.url ?? 'http://203.0.113.7/',
    deployedAt: '2026-07-13T12:00:00Z',
    machineType: 'e2-micro',
  };
  return `${ANNOUNCE_MARKER}\n${overrides.extra ?? '**Preview VM ready**'}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

describe('preview-target parsing (pure)', () => {
  it('resolves the announce URL on the happy path', () => {
    const comments: AnnounceComment[] = [
      { body: 'CI is green 🎉', createdAt: '2026-07-13T11:00:00Z' },
      { body: announceComment(), createdAt: '2026-07-13T12:00:00Z' },
    ];
    const announce = resolveAnnounceFromComments(comments, 20);
    expect(announce.url).toBe('http://203.0.113.7/');
    expect(announce.vm).toBe('mog-pr-20');
    expect(announce.pr).toBe(20);
    expect(announce.machineType).toBe('e2-micro');
  });

  it('throws NoAnnounceError when no comment carries the marker', () => {
    const comments: AnnounceComment[] = [
      { body: 'looks good to me', createdAt: '2026-07-13T11:00:00Z' },
      { body: 'approved ✅', createdAt: '2026-07-13T11:30:00Z' },
    ];
    expect(() => resolveAnnounceFromComments(comments, 42)).toThrow(NoAnnounceError);
    expect(() => resolveAnnounceFromComments(comments, 42)).toThrow(/no preview VM announced on PR 42/);
  });

  it('throws AnnounceParseError on a malformed json fence', () => {
    const broken = `${ANNOUNCE_MARKER}\nPreview ready\n\n\`\`\`json\n{ "url": "http://203.0.113.7/", pr: 20, }\n\`\`\`\n`;
    const comments: AnnounceComment[] = [{ body: broken, createdAt: '2026-07-13T12:00:00Z' }];
    expect(() => resolveAnnounceFromComments(comments, 20)).toThrow(AnnounceParseError);
    expect(() => resolveAnnounceFromComments(comments, 20)).toThrow(/malformed/);
  });

  it('throws AnnounceParseError when the marker comment has no json fence', () => {
    const comments: AnnounceComment[] = [{ body: `${ANNOUNCE_MARKER}\njust prose, no fence`, createdAt: '2026-07-13T12:00:00Z' }];
    expect(() => resolveAnnounceFromComments(comments, 20)).toThrow(/no ```json fenced block/);
  });

  it('throws AnnounceParseError when the fence lacks a url', () => {
    const noUrl = `${ANNOUNCE_MARKER}\n\`\`\`json\n{ "pr": 20, "vm": "mog-pr-20" }\n\`\`\``;
    expect(() => parseAnnounceBody(noUrl)).toThrow(/missing a "url"/);
  });

  it('takes the latest of multiple announce comments (by createdAt)', () => {
    const comments: AnnounceComment[] = [
      { body: announceComment({ url: 'http://198.51.100.1/', sha: 'old' }), createdAt: '2026-07-13T10:00:00Z' },
      { body: announceComment({ url: 'http://203.0.113.9/', sha: 'new' }), createdAt: '2026-07-13T14:00:00Z' },
      { body: 'unrelated chatter', createdAt: '2026-07-13T15:00:00Z' },
    ];
    const announce = resolveAnnounceFromComments(comments, 20);
    expect(announce.url).toBe('http://203.0.113.9/');
    expect(announce.sha).toBe('new');
  });

  it('takes the later-positioned announce when timestamps are missing', () => {
    const comments: AnnounceComment[] = [
      { body: announceComment({ url: 'http://198.51.100.1/' }), createdAt: '' },
      { body: announceComment({ url: 'http://203.0.113.9/' }), createdAt: '' },
    ];
    expect(selectAnnounceComment(comments)?.body).toContain('203.0.113.9');
  });
});

describe('isRemoteClientUrl', () => {
  it('classifies loopback hosts as local', () => {
    expect(isRemoteClientUrl('http://localhost:5173')).toBe(false);
    expect(isRemoteClientUrl('http://127.0.0.1:5173')).toBe(false);
    expect(isRemoteClientUrl('http://[::1]:5173')).toBe(false);
  });
  it('classifies preview VM IPs as remote', () => {
    expect(isRemoteClientUrl('http://203.0.113.7/')).toBe(true);
  });
});

describe('parsePrArg', () => {
  it('parses --pr N and --pr=N', () => {
    expect(parsePrArg(['--pr', '20'])).toBe(20);
    expect(parsePrArg(['--pr=7'])).toBe(7);
  });
  it('returns undefined when absent', () => {
    expect(parsePrArg(['--publish', '--update-baseline'])).toBeUndefined();
  });
  it('rejects non-numeric / non-positive values', () => {
    expect(() => parsePrArg(['--pr', 'abc'])).toThrow(/positive PR number/);
    expect(() => parsePrArg(['--pr', '0'])).toThrow(/positive PR number/);
  });
});

describe('fetchPrComments (gh layer with injected runner)', () => {
  it('maps gh api json into AnnounceComment and resolves via the injected runner', () => {
    const fakeGh = (args: string[]): string => {
      expect(args).toEqual(['api', 'repos/asavs/mog-template/issues/20/comments', '--paginate']);
      return JSON.stringify([
        { body: 'first!', created_at: '2026-07-13T11:00:00Z' },
        { body: announceComment(), created_at: '2026-07-13T12:00:00Z' },
      ]);
    };
    const comments = fetchPrComments(20, 'asavs/mog-template', fakeGh);
    expect(comments).toHaveLength(2);
    const announce = resolvePreviewTarget(20, { repo: 'asavs/mog-template', run: fakeGh });
    expect(announce.url).toBe('http://203.0.113.7/');
  });
});
