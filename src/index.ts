/**
 * @nuckty/ext-command-content-external — `nuckty content-external` command-extension.
 *
 * Registers the `content-external` CLI command: clone or update the external git
 * repositories listed in `config/external.json` into `external/<repo>/`. This is
 * a separate step from `nuckty build` — the build reads whatever is already on
 * disk in the selected content levels. This command requires Git for repository
 * preparation and Git LFS for updates; the core may query Git for source commit
 * timestamps. Offline builds require prepared inputs and extensions that do
 * not access the network.
 *
 * @module @nuckty/ext-command-content-external
 */

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import type { NucktyEnv, CommandArgs } from '@nuckty/core';

/** `nuckty content-external [--dry-run]` — clone or update external content repos. */
async function contentExternal(args: CommandArgs): Promise<number> {
    const unknownFlag = Object.keys(args.flags).find((name) => name !== 'dry-run');
    if (unknownFlag !== undefined) {
        process.stderr.write('nuckty: content-external: unknown flag\n');
        return 1;
    }
    if (args.positional.length > 0) {
        process.stderr.write('nuckty: content-external: unexpected positional argument\n');
        return 1;
    }

    const dryRunFlag = args.flags['dry-run'];
    if (typeof dryRunFlag === 'string' && dryRunFlag !== 'true' && dryRunFlag !== 'false') {
        process.stderr.write('nuckty: content-external: --dry-run must be true or false\n');
        return 1;
    }
    const dryRun = dryRunFlag === true || dryRunFlag === 'true';
    const externalDir = path.resolve(args.cwd, 'external');
    const configPath = path.resolve(args.cwd, 'config', 'external.json');

    let urls: string[] = [];
    if (fs.existsSync(configPath)) {
        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            // CMD-09: the schema is `string[]`, the WHOLE schema. A wrong
            // shape must fail loudly — an object or a list with non-string
            // values used to be filtered down to [] and exit 0 ("success"
            // while preparing nothing).
            if (!Array.isArray(parsed) || parsed.some((u) => typeof u !== 'string')) {
                throw new Error(
                    'config/external.json must be a JSON array of repository URL strings',
                );
            }
            urls = parsed;
        } catch (e) {
            process.stderr.write(`nuckty: content-external failed to parse config/external.json: ${(e as Error).message}\n`);
            return 1;
        }
    }

    // Lazy-import so `register(env)` does not pull simple-git — only an actual
    // invocation pays that cost (and needs simple-git installed in the consumer).
    const { planRepos, runPlan, fsStatus, makeGitRunner } = await import('./content-external.js');

    // Resolve each repo's status (clean → update, absent → clone, dirty,
    // mismatched, or unknown → refuse; existing copies are never deleted)
    // via the shared
    // `planRepos` with the real `fsStatus` (async through simple-git).
    let plan;
    try {
        plan = await planRepos(urls, externalDir, fsStatus);
    } catch (error) {
        process.stderr.write(`nuckty: content-external planning failed: ${(error as Error).message}\n`);
        return 1;
    }

    const runner = makeGitRunner();
    const results = await runPlan(plan, runner, dryRun);

    for (const r of results) {
        if (dryRun) {
            process.stdout.write(`nuckty: content-external — would ${r.action} ${r.name}\n`);
        } else if (!r.ok) {
            process.stderr.write(`nuckty: content-external — ${r.action} ${r.name} failed: ${r.error ?? ''}\n`);
        } else {
            process.stdout.write(`nuckty: content-external — ${r.action} ${r.name} ok\n`);
        }
    }
    return results.every((r) => r.ok) ? 0 : 1;
}

export function register(env: NucktyEnv): void {
    env.commands.add(
        'content-external',
        'clone or update external content repositories from config/external.json',
        contentExternal,
        { booleanFlags: ['dry-run'] },
    );
}

export default register;
