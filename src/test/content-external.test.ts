/**
 * Tests for the content-external command-extension's pure helpers (openspec
 * `ext-command-content-external`): `getRepoName` (SSH + HTTPS URL forms, with/without
 * `.git`), `planRepos` (clone vs update decision from an injected status check),
 * and `runPlan` (dry-run reports without touching disk; clone/update dispatch;
 * a failing repo records an error but does not abort the rest). The git execution
 * runner itself is tested through an injected `GitRunner`; the filesystem
 * ownership checks use temporary local Git repositories and never access the
 * network.
 *
 * @module test/content-external
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { getRepoName, planRepos, runPlan, type GitRunner, type RepoStatus } from '../content-external.js';
import { register } from '../index.js';
import type { CommandArgs, CommandHandler, CommandOptions, NucktyEnv } from '@nuckty/core';

test('content-external validates arguments before reading config', async (t) => {
    let handler: CommandHandler | undefined;
    let options: CommandOptions | undefined;
    register({
        commands: {
            add(_name: string, _description: string, registered: CommandHandler, registeredOptions?: CommandOptions) {
                handler = registered;
                options = registeredOptions;
            },
        },
    } as unknown as NucktyEnv);
    assert.deepEqual(options?.booleanFlags, ['dry-run']);
    assert.ok(handler);

    let configChecks = 0;
    t.mock.method(fs, 'existsSync', () => {
        configChecks++;
        return false;
    });

    let stderr = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
    }) as typeof process.stderr.write;
    try {
        const args: CommandArgs = {
            positional: [],
            flags: { 'dry-run': 'sometimes' },
            config: {} as CommandArgs['config'],
            cwd: '/tmp/nuckty-invalid-boolean',
        };
        assert.equal(await handler(args), 1);
        assert.equal(await handler({ ...args, flags: { dryrun: true } }), 1);
        assert.equal(await handler({ ...args, positional: ['staging'], flags: {} }), 1);
        assert.equal(configChecks, 0, 'invalid arguments must be rejected before config filesystem checks');
        assert.match(stderr, /--dry-run must be true or false/);
        assert.match(stderr, /unknown flag/);
        assert.match(stderr, /unexpected positional argument/);

        assert.equal(await handler({ ...args, flags: { 'dry-run': true } }), 0);
        assert.equal(await handler({ ...args, flags: { 'dry-run': 'true' } }), 0);
        assert.equal(await handler({ ...args, flags: { 'dry-run': 'false' } }), 0);
        assert.equal(configChecks, 3, 'supported dry-run forms proceed to config handling');
    } finally {
        process.stderr.write = originalWrite;
    }
});

// ---- getRepoName -----------------------------------------------------------

test('getRepoName: SSH form with .git', () => {
    assert.equal(getRepoName('git@github.com:voyahchat/voyahchat-content.git'), 'voyahchat-content');
});

test('getRepoName: HTTPS form with .git', () => {
    assert.equal(getRepoName('https://github.com/voyahchat/voyahchat-content.git'), 'voyahchat-content');
});

test('getRepoName: HTTPS form without .git', () => {
    assert.equal(getRepoName('https://github.com/voyahchat/voyahchat-content'), 'voyahchat-content');
});

test('getRepoName: SSH form with a port in the host still yields the repo name', () => {
    assert.equal(getRepoName('ssh://git@gitlab.example.com:2222/org/repo.git'), 'repo');
});

test('getRepoName: throws on a URL with no parseable name', () => {
    assert.throws(() => getRepoName(''), /Could not parse/);
});

test('getRepoName rejection does not disclose query or fragment values', () => {
    for (const url of [
        'https://host/org/repo.git?token=SYNTHETIC_SECRET',
        'https://host/org/repo.git#SYNTHETIC_SECRET',
    ]) {
        assert.throws(() => getRepoName(url), (error: Error) => {
            assert.match(error.message, /Unsafe repository name/);
            assert.doesNotMatch(error.message, /SYNTHETIC_SECRET/);
            return true;
        });
    }
});

// ---- planRepos --------------------------------------------------------------

/** A sync status check backed by a set of existing dirs + their cleanliness. */
function statusFrom(map: Record<string, RepoStatus>) {
    return (dir: string) => map[dir] ?? 'none';
}

test('planRepos: absent dir → clone', async () => {
    const external = '/tmp/external';
    const plan = await planRepos(['https://h/o/r.git'], external, statusFrom({}));
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.name, 'r');
    assert.equal(plan[0]!.dir, path.join(external, 'r'));
    assert.equal(plan[0]!.action, 'clone');
});

test('planRepos: clean existing dir → update', async () => {
    const external = '/tmp/external';
    const dir = path.join(external, 'r');
    const plan = await planRepos(['https://h/o/r.git'], external, statusFrom({ [dir]: 'clean' }));
    assert.equal(plan[0]!.action, 'update');
});

test('planRepos: dirty existing dir → refuse (never delete local changes)', async () => {
    const external = '/tmp/external';
    const dir = path.join(external, 'r');
    const plan = await planRepos(['https://h/o/r.git'], external, statusFrom({ [dir]: 'dirty' }));
    assert.equal(plan[0]!.action, 'refuse');
});

test('planRepos: mismatched and unknown repository status use distinct refusal reasons', async () => {
    const external = '/tmp/external';
    const mismatch = await planRepos(['https://github.com/o/r.git'], external, () => 'identity-mismatch');
    const unknown = await planRepos(['https://github.com/o/other.git'], external, () => 'unknown');
    assert.equal(mismatch[0]!.action, 'refuse');
    assert.equal(mismatch[0]!.refusalReason, 'repository-identity-mismatch');
    assert.equal(unknown[0]!.action, 'refuse');
    assert.equal(unknown[0]!.refusalReason, 'repository-status-unknown');
});

test('planRepos: empty url array → empty plan (no work)', async () => {
    const plan = await planRepos([], '/tmp/external', statusFrom({}));
    assert.equal(plan.length, 0);
});

// ---- runPlan ----------------------------------------------------------------

/** A fake runner that records calls and can be made to fail on a chosen repo. */
function fakeRunner(failOn?: string): GitRunner & { calls: Array<{ kind: string; url?: string; dir: string }> } {
    const calls: Array<{ kind: string; url?: string; dir: string }> = [];
    return {
        calls,
        async clone(url, dir) {
            calls.push({ kind: 'clone', url, dir });
            if (failOn !== undefined && dir.endsWith(failOn)) throw new Error('boom');
        },
        async update(dir) {
            calls.push({ kind: 'update', dir });
            if (failOn !== undefined && dir.endsWith(failOn)) throw new Error('boom');
        },
    };
}

test('runPlan: dry-run reports the plan and runs nothing', async () => {
    const plan = [
        { url: 'u1', name: 'a', dir: '/x/a', action: 'clone' as const },
        { url: 'u2', name: 'b', dir: '/x/b', action: 'update' as const },
    ];
    const runner = fakeRunner();
    const results = await runPlan(plan, runner, true);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.ok));
    assert.equal(runner.calls.length, 0, 'dry-run must not touch git');
});

test('runPlan: clone then update dispatched correctly', async () => {
    const plan = [
        { url: 'u1', name: 'a', dir: '/x/a', action: 'clone' as const },
        { url: 'u2', name: 'b', dir: '/x/b', action: 'update' as const },
    ];
    const runner = fakeRunner();
    await runPlan(plan, runner, false);
    assert.equal(runner.calls.length, 2);
    assert.equal(runner.calls[0]!.kind, 'clone');
    assert.equal(runner.calls[0]!.url, 'u1');
    assert.equal(runner.calls[1]!.kind, 'update');
    assert.equal(runner.calls[1]!.dir, '/x/b');
});

test('runPlan: a failing repo records an error but the rest still run', async () => {
    const plan = [
        { url: 'u1', name: 'a', dir: '/x/a', action: 'clone' as const },
        { url: 'u2', name: 'b', dir: '/x/b', action: 'update' as const },
    ];
    const runner = fakeRunner('a');
    const results = await runPlan(plan, runner, false);
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.error ?? '', /boom/);
    assert.equal(results[1]!.ok, true);
});

test('runPlan: refuse never calls the runner and reports local changes only for a dirty tree', async () => {
    const plan = [{ url: 'u', name: 'r', dir: '/x/r', action: 'refuse' as const, refusalReason: 'local-changes' as const }];
    const runner = fakeRunner();
    const results = await runPlan(plan, runner, false);
    assert.equal(runner.calls.length, 0, 'refuse must not touch git or the filesystem');
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.error ?? '', /local changes/);
});

test('runPlan: identity mismatch is not described as local changes', async () => {
    const plan = [{ url: 'u', name: 'r', dir: '/x/r', action: 'refuse' as const, refusalReason: 'repository-identity-mismatch' as const }];
    const runner = fakeRunner();
    const results = await runPlan(plan, runner, false);
    assert.equal(runner.calls.length, 0);
    assert.match(results[0]!.error ?? '', /different repository/);
    assert.doesNotMatch(results[0]!.error ?? '', /local changes/);
});

test('runPlan: unknown repository status is not described as local changes', async () => {
    const plan = [{ url: 'u', name: 'r', dir: '/x/r', action: 'refuse' as const, refusalReason: 'repository-status-unknown' as const }];
    const runner = fakeRunner();
    const results = await runPlan(plan, runner, false);
    assert.equal(runner.calls.length, 0);
    assert.match(results[0]!.error ?? '', /could not be verified/);
    assert.doesNotMatch(results[0]!.error ?? '', /local changes/);
});

test('runPlan redacts URL credentials from runner errors', async () => {
    const runner = fakeRunner();
    runner.clone = async () => {
        throw new Error(
            'failed https://user:secret@github.com/owner/repo.git?token=QUERY_SECRET#FRAGMENT_SECRET ' +
                'git@github.com:owner/repo.git?token=SCP_QUERY_SECRET#SCP_FRAGMENT_SECRET',
        );
    };
    const results = await runPlan([{ url: 'u', name: 'r', dir: '/x/r', action: 'clone' }], runner, false);
    assert.match(results[0]!.error ?? '', /https:\/\/\[redacted\]@github.com/);
    assert.doesNotMatch(results[0]!.error ?? '', /secret|QUERY_SECRET|FRAGMENT_SECRET/);
    assert.match(results[0]!.error ?? '', /github\.com\/owner\/repo\.git/);
    assert.match(results[0]!.error ?? '', /git@github\.com:owner\/repo\.git/);
});

// ---- CMD-08: adversarial names and duplicate destinations -------------------

test('getRepoName rejects `..`, `.`, and separator-containing names', () => {
    assert.throws(() => getRepoName('https://h/o/..'), /Unsafe repository name/);
    assert.throws(() => getRepoName('https://h/o/.'), /Unsafe repository name/);
    assert.throws(() => getRepoName('https://h/o/repo\\nested.git'), /Unsafe repository name/);
});

test('planRepos rejects duplicate destinations from same-basename URLs', async () => {
    await assert.rejects(
        () => planRepos(['https://h/o/photo.git', 'https://h/p/photo.git'], '/tmp/external', () => 'none'),
        /Duplicate repository destination/,
    );
});

test('planRepos containment: a dir escaping externalDir is refused pre-runner', async () => {
    // Even if a name slipped past getRepoName, the resolve check must hold.
    await assert.rejects(
        () => planRepos(['https://h/o/..'], '/tmp/external', () => 'none'),
        /Unsafe repository name/,
    );
});

import { makeGitRunner, fsStatus } from '../content-external.js';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { simpleGit } from 'simple-git';

for (const mode of ['empty', 'list-error', 'pull-error'] as const) {
    test(`real git runner propagates LFS ${mode}`, async () => {
        const commands: string[] = [];
        const fake = (() => ({
            pull: async () => {},
            raw: async (args: string[]) => {
                commands.push(args.join(' '));
                if (mode === 'list-error' || args[1] === 'pull') {
                    throw new Error('LFS failure');
                }
                return mode === 'empty' ? '' : 'object path';
            },
        })) as unknown as typeof simpleGit;
        const runner = makeGitRunner(async () => ({ simpleGit: fake }));
        if (mode === 'empty') {
            await runner.update('/fixture');
            assert.deepEqual(commands, ['lfs ls-files']);
        } else {
            await assert.rejects(runner.update('/fixture'), /LFS|lfs/);
            assert.equal(commands.length, mode === 'list-error' ? 1 : 2);
        }
    });
}

test('ownership refuses repository symlinks and whitespace names', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-content-owner-'));
    try {
        await mkdir(path.join(dir, 'external'));
        await mkdir(path.join(dir, 'other'));
        await symlink(path.join(dir, 'other'), path.join(dir, 'external', 'repo'));
        await assert.rejects(planRepos(['https://host/repo'], path.join(dir, 'external'), () => 'clean'), /symbolic link/);
        assert.equal(await fsStatus(path.join(dir, 'external', 'repo')), 'unknown');
        assert.throws(() => getRepoName('https://host/   '), /Unsafe/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const git = promisify(execFile);

test('filesystem ownership requires repository root and same configured origin', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-content-git-'));
    try {
        await git('git', ['init', '-q', dir]);
        await git('git', ['-C', dir, 'remote', 'add', 'origin', 'https://fixture.invalid/content.git']);
        await mkdir(path.join(dir, 'nested'));
        assert.equal(await fsStatus(dir, 'https://fixture.invalid/content.git'), 'clean');
        assert.equal(await fsStatus(dir, 'https://fixture.invalid/other.git'), 'identity-mismatch');
        assert.equal(await fsStatus(path.join(dir, 'nested'), 'https://fixture.invalid/content.git'), 'identity-mismatch');
        await writeFile(path.join(dir, 'untracked'), 'work');
        assert.equal(await fsStatus(dir, 'https://fixture.invalid/content.git'), 'dirty');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('filesystem ownership with no origin is unknown and remains guarded', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-content-no-origin-'));
    try {
        await git('git', ['init', '-q', dir]);
        assert.equal(await fsStatus(dir, 'https://github.com/owner/repo.git'), 'unknown');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('filesystem ownership accepts HTTPS CI clone of configured GitHub SSH repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-content-github-origin-'));
    const configured = 'git@github.com:voyahchat/voyahchat-content.git';
    try {
        await git('git', ['init', '-q', dir]);
        await git('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/voyahchat/voyahchat-content.git']);
        assert.equal(await fsStatus(dir, configured), 'clean');

        await git('git', ['-C', dir, 'remote', 'set-url', 'origin', 'ssh://git@github.com/voyahchat/voyahchat-content.git']);
        assert.equal(await fsStatus(dir, configured), 'clean');

        await git('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/other-owner/voyahchat-content.git']);
        assert.equal(await fsStatus(dir, configured), 'identity-mismatch');
        await git('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/voyahchat/other-repo.git']);
        assert.equal(await fsStatus(dir, configured), 'identity-mismatch');
        await git('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com.evil.invalid/voyahchat/voyahchat-content.git']);
        assert.equal(await fsStatus(dir, configured), 'identity-mismatch');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('filesystem ownership does not normalize SSH and HTTPS for non-GitHub hosts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-content-foreign-origin-'));
    try {
        await git('git', ['init', '-q', dir]);
        await git('git', ['-C', dir, 'remote', 'add', 'origin', 'git@gitlab.com:owner/repo.git']);
        assert.equal(await fsStatus(dir, 'https://gitlab.com/owner/repo.git'), 'identity-mismatch');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

import { readFile, writeFile, readdir } from 'node:fs/promises';

for (const mode of ['failed-clone', 'destination-appeared'] as const) {
    test(`clone ownership: ${mode} cleans only its temporary sibling`, async () => {
        const parent = await mkdtemp(path.join(tmpdir(), 'nuckty-content-clone-'));
        const destination = path.join(parent, 'repo');
        const fake = (() => ({ clone: async (_url: string, temporary: string) => {
            await writeFile(path.join(temporary, 'partial'), 'partial');
            if (mode === 'failed-clone') {
                throw new Error('clone failed');
            }
            await mkdir(destination);
            await writeFile(path.join(destination, 'owned'), 'preserve');
        } })) as unknown as typeof simpleGit;
        try {
            await assert.rejects(makeGitRunner(async () => ({ simpleGit: fake })).clone('fixture', destination));
            assert.deepEqual(await readdir(parent), mode === 'failed-clone' ? [] : ['repo']);
            if (mode === 'destination-appeared') {
                assert.equal(await readFile(path.join(destination, 'owned'), 'utf8'), 'preserve');
            }
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
}
