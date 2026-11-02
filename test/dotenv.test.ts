import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as plugin from '../src/index.js';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { createHost, textResponse } from './host.js';

const prefix = `DSH_DOTENV_TEST_${process.pid}_`;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dotenv-'));
  const host = await createHost(root);
  t.after(async () => {
    await host.close(); await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (key.startsWith(prefix)) delete process.env[key];
  });
  return { ...host, root };
}

test('startup loads Node dotenv syntax, BOM, multiline and preserves inherited and empty variables', async (t) => {
  const host = await fixture(t);
  process.env[`${prefix}EXISTING`] = 'inherited'; process.env[`${prefix}EMPTY`] = '';
  await writeFile(join(host.root, '.env'), `\uFEFFexport ${prefix}NEW="secret # value"\n${prefix}EXISTING=replaced\n${prefix}EMPTY=replaced\n${prefix}MULTI="first\nsecond"\n${prefix}LITERAL='$UNEXPANDED'\n`);
  await host.ctx.plugin(plugin, { root: host.root, path: '.env' });
  assert.equal(process.env[`${prefix}NEW`], 'secret # value');
  assert.equal(process.env[`${prefix}EXISTING`], 'inherited'); assert.equal(process.env[`${prefix}EMPTY`], '');
  assert.equal(process.env[`${prefix}MULTI`], 'first\nsecond'); assert.equal(process.env[`${prefix}LITERAL`], '$UNEXPANDED');
  await host.close();
  assert.equal(process.env[`${prefix}NEW`], 'secret # value');
});

test('absent config.path never discovers .env; no secret-reading tools or model context', async (t) => {
  const host = await fixture(t);
  await writeFile(join(host.root, '.env'), `${prefix}IMPLICIT=must-not-load`);
  await host.ctx.plugin(plugin, { root: host.root });
  assert.equal(process.env[`${prefix}IMPLICIT`], undefined);
  await writeFile(join(host.root, 'explicit.env'), `${prefix}EXPLICIT=secret-sentinel-9472`);
  await host.ctx.plugin(plugin, { root: host.root, path: 'explicit.env' });
  host.model.responses.push(textResponse());
  const { agent } = await host.create();
  agent.followup({ id: MessageId('dotenv-prompt'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] });
  await agent.whenIdle();
  assert.deepEqual(host.errors, []);
  const request = JSON.stringify(host.model.requests);
  assert.doesNotMatch(request, /secret-sentinel-9472|DSH_DOTENV_TEST_|dotenv_read|dotenv_get/);
  assert.equal((await host.execute('dotenv_read', {})).isError, true);
});

test('missing, empty, traversal, absolute escape, directory, symlink, hardlink and oversized paths fail without partial environment writes', async (t) => {
  const host = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'dsh-dotenv-outside-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'private.env'), `${prefix}ESCAPE=secret-sentinel-invalid`);
  await symlink(external, join(host.root, 'linked-dir'));
  await symlink(join(external, 'private.env'), join(host.root, 'linked.env'));
  await link(join(external, 'private.env'), join(host.root, 'hard.env'));
  await mkdir(join(host.root, 'directory'));
  await writeFile(join(host.root, 'large.env'), `${prefix}PARTIAL=secret-sentinel-invalid\n#${'x'.repeat(256 * 1024)}`);
  for (const path of ['', 'missing.env', '../escape.env', join(external, 'private.env'), 'directory', 'linked.env', 'linked-dir/private.env', 'hard.env', 'large.env']) {
    await assert.rejects(async () => { await host.ctx.plugin(plugin, { root: host.root, path }); }, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /could not load configured file/);
      assert.doesNotMatch(error.message, /secret-sentinel|private.env|PARTIAL/);
      return true;
    });
  }
  assert.equal(process.env[`${prefix}ESCAPE`], undefined); assert.equal(process.env[`${prefix}PARTIAL`], undefined);
});

test('simultaneous plugin loads use first writer without replacing values and do not watch later changes', async (t) => {
  const host = await fixture(t);
  await writeFile(join(host.root, 'a.env'), `${prefix}RACE=a`);
  await writeFile(join(host.root, 'b.env'), `${prefix}RACE=b`);
  await Promise.all(['a.env', 'b.env'].map((path) => host.ctx.plugin(plugin, { root: host.root, path })));
  assert.ok(['a', 'b'].includes(process.env[`${prefix}RACE`] ?? ''));
  const value = process.env[`${prefix}RACE`];
  await writeFile(join(host.root, 'a.env'), `${prefix}RACE=changed`);
  assert.equal(process.env[`${prefix}RACE`], value);
});


test('dispose during pending startup drains file work without publishing environment', async (t) => {
  const host = await fixture(t);
  await writeFile(join(host.root, 'pending.env'), `${prefix}DISPOSED=must-not-publish`);
  const fiber = host.ctx.plugin(plugin, { root: host.root, path: 'pending.env' });
  const loaded = Promise.resolve(fiber).catch(() => {});
  for (let i = 0; i < 20 && !fiber.getEffects().some((effect) => effect.label === 'dotenv startup lifetime'); i++) await Promise.resolve();
  assert.ok(fiber.getEffects().some((effect) => effect.label === 'dotenv startup lifetime'), 'startup has begun its actual filesystem read');
  await fiber.dispose();
  await loaded;
  assert.equal(process.env[`${prefix}DISPOSED`], undefined);
});

test('ordinary nested file and contained absolute path are accepted', async (t) => {
  const host = await fixture(t);
  await mkdir(join(host.root, 'config'));
  await writeFile(join(host.root, 'config/local.env'), `${prefix}NESTED=loaded`);
  await host.ctx.plugin(plugin, { root: host.root, path: 'config/local.env' });
  assert.equal(process.env[`${prefix}NESTED`], 'loaded');
  await writeFile(join(host.root, 'absolute.env'), `${prefix}ABSOLUTE=loaded`);
  await host.ctx.plugin(plugin, { root: host.root, path: join(host.root, 'absolute.env') });
  assert.equal(process.env[`${prefix}ABSOLUTE`], 'loaded');
});
