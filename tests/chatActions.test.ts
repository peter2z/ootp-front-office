import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ACTING_TOOLS, CHAT_TOOLS, TOOLS, runChatTool, runTool } from '../server/chat.js';
import { db } from '../server/db.js';
import { historyDb } from '../server/history.js';
import { personaById } from '../server/staff.js';
import request, { post } from './request.js';
import { IDS } from './fixture.js';

/**
 * The assistant being able to do something about what it has just read.
 *
 * "The assistant can read but never act. Nineteen read-only tools; it cannot
 * watch a player, file a note or mark a card done."
 *
 * Three of those now exist: watch a player, take him off the list, and file a
 * note on his card. The fourth, marking a recommendation done, does not,
 * because the app has no state on a recommendation to mark: there is nowhere
 * for it to be written, and inventing a place would be building the feature
 * rather than giving the assistant a hand with it.
 *
 * What these tests hold to is the line the three sit on. They change the
 * reader's own notebook in this app and nothing in OOTP, they say so in the
 * model's hearing, they are never given to the trade desk, and what they report
 * is what happened, since the reply is built from it.
 */

const LIMIT = 20_000;

const nameOf = (id: number): string => {
  const row = db.prepare(`SELECT first_name, last_name FROM players WHERE player_id = ?`).get(id) as {
    first_name: string; last_name: string;
  };
  return `${row.first_name} ${row.last_name}`;
};
const watchRow = (id: number) =>
  historyDb.prepare(`SELECT * FROM watchlist WHERE player_id = ?`).get(id) as
    | { player_id: number; name: string; note: string }
    | undefined;
const notesOn = (id: number) =>
  historyDb.prepare(`SELECT * FROM player_notes WHERE player_id = ? ORDER BY id`).all(id) as Array<{
    player_name: string; source: string; body: string;
  }>;

beforeAll(async () => {
  await request('/api/status'); // starts the server the page-facing routes live on
}, LIMIT);

beforeEach(() => {
  // Only this test file runs against this history database, and a test should start from nothing
  historyDb.prepare(`DELETE FROM watchlist`).run();
  historyDb.prepare(`DELETE FROM player_notes`).run();
});

describe('the tools that act', () => {
  const names = ACTING_TOOLS.map((t) => t.name);

  it('are the three the assistant was missing', () => {
    expect(names).toEqual(['watch_player', 'unwatch_player', 'add_note']);
  });

  it('are offered to the staff chat after everything that reads', () => {
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual([...TOOLS.map((t) => t.name), ...names]);
  });

  it('are each named once across everything the chat is offered', () => {
    const all = CHAT_TOOLS.map((t) => t.name);
    expect(new Set(all).size, `duplicate tool name in ${all.join(', ')}`).toBe(all.length);
  });

  /*
   * The sentence that matters most. A model that takes "watch" to mean
   * something in the game will promise a roster move it cannot make.
   */
  it('say in their descriptions that they change this app and nothing in OOTP', () => {
    for (const t of ACTING_TOOLS) {
      expect(t.description, `${t.name} does not say it is app-only`).toMatch(/in this app/i);
      expect(t.description, `${t.name} does not rule out OOTP`).toMatch(/nothing in OOTP/i);
    }
  });

  it('tell the model to act only when asked, and to say afterwards what it did', () => {
    for (const t of ACTING_TOOLS) {
      expect(t.description, `${t.name} may be used unasked`).toMatch(/only when the user asks/i);
      expect(t.description, `${t.name} does not ask for a confirmation`).toMatch(/say in your reply/i);
    }
  });

  it('ask for the player by id, and the note by text', () => {
    for (const t of ACTING_TOOLS) {
      const schema = t.input_schema as { properties: Record<string, unknown>; required?: string[] };
      expect(schema.required).toContain('player_id');
      expect(Object.keys(schema.properties)).toContain('player_id');
    }
    const note = ACTING_TOOLS.find((t) => t.name === 'add_note')!.input_schema as { required: string[] };
    expect(note.required).toContain('note');
  });

  it('are wired, so the dispatcher knows every one by name', async () => {
    for (const t of ACTING_TOOLS) {
      const out = await runChatTool(t.name, { player_id: IDS.starter, note: 'Wired.' });
      expect(typeof out === 'string' && out.length > 0, `${t.name} answered with nothing`).toBe(true);
    }
  });

  /*
   * The trade desk is handed TOOLS and calls runTool. Keeping the writes out of
   * both is what stops a model that was only asked to weigh a deal from
   * changing anything while it does, even by inventing a call it was never offered.
   */
  it('are not in the list the trade desk is given', () => {
    for (const n of names) expect(TOOLS.map((t) => t.name)).not.toContain(n);
    for (const t of TOOLS) {
      expect(t.name, `${t.name} reads like a write`).toMatch(/^(get_|search_)/);
    }
  });

  it('are refused by the dispatcher the trade desk calls', async () => {
    for (const n of names) {
      await expect(runTool(n, { player_id: IDS.starter, note: 'x' })).rejects.toThrow(/unknown tool/i);
    }
    expect(watchRow(IDS.starter)).toBeUndefined();
    expect(notesOn(IDS.starter)).toEqual([]);
  });
});

describe('watching a player', () => {
  it('writes the watchlist row, and says so in words the model can repeat', async () => {
    const said = await runChatTool('watch_player', { player_id: IDS.starter });

    expect(said).toBe(`Added ${nameOf(IDS.starter)} to the watchlist.`);
    expect(watchRow(IDS.starter)).toMatchObject({ player_id: IDS.starter, name: nameOf(IDS.starter), note: '' });
  });

  it('shows up on the page that lists the watchlist', async () => {
    await runChatTool('watch_player', { player_id: IDS.starter });

    const list = (await request('/api/watchlist')) as Array<{ player_id: number; name: string }>;
    expect(list.map((w) => w.player_id)).toContain(IDS.starter);
  });

  it('says nothing changed when he was already there, and keeps the note written on him', async () => {
    await post('/api/watchlist', { player_id: IDS.starter, name: nameOf(IDS.starter), note: 'Watch the elbow.' });
    const said = await runChatTool('watch_player', { player_id: IDS.starter });

    // "Already" and "added" are different facts, and a model told only "ok" will claim the second
    expect(said).toMatch(/already on the watchlist/i);
    expect(said).toMatch(/nothing changed/i);
    expect(watchRow(IDS.starter)?.note).toBe('Watch the elbow.');
  });

  it('refuses a man who is not in the save, and writes nothing', async () => {
    await expect(runChatTool('watch_player', { player_id: 987654 })).rejects.toThrow(/no player with player_id 987654/i);
    expect(watchRow(987654)).toBeUndefined();
  });

  it('refuses a call that names nobody', async () => {
    for (const bad of [{}, { player_id: 'Gerrit Cole' }, { player_id: -4 }, { player_id: 1.5 }]) {
      await expect(runChatTool('watch_player', bad)).rejects.toThrow(/player_id is required/i);
    }
  });
});

/**
 * The page and the assistant write the same row, so they share the one write.
 *
 * It used to turn a missing note into an empty one, which for the page was
 * harmless — it always sends the note it is showing — and for anything that
 * watches a man without sending one would have wiped what was written on him.
 */
describe('the page writing the same row', () => {
  it('keeps a note when it watches him again without sending one', async () => {
    await post('/api/watchlist', { player_id: IDS.starter, name: nameOf(IDS.starter), note: 'Mine.' });
    await post('/api/watchlist', { player_id: IDS.starter, name: nameOf(IDS.starter) });

    expect(watchRow(IDS.starter)?.note).toBe('Mine.');
  });

  it('still clears a note the reader emptied, which is a note and not an absence', async () => {
    await post('/api/watchlist', { player_id: IDS.starter, name: nameOf(IDS.starter), note: 'Mine.' });
    await post('/api/watchlist', { player_id: IDS.starter, name: nameOf(IDS.starter), note: '' });

    expect(watchRow(IDS.starter)?.note).toBe('');
  });

  it('still takes him off the list when the page asks', async () => {
    await runChatTool('watch_player', { player_id: IDS.starter });
    const res = await fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/watchlist/${IDS.starter}`, {
      method: 'DELETE',
    });

    expect(res.ok).toBe(true);
    expect(watchRow(IDS.starter)).toBeUndefined();
  });

  it('still files a note through the route the chat window saves to', async () => {
    await post('/api/player-notes', {
      player_id: IDS.starter, player_name: nameOf(IDS.starter), source: 'Skip Ratchet', body: ' Rest him Thursday. ',
    });
    await post('/api/player-notes', { player_id: IDS.starter, body: 'Second.' });

    const notes = notesOn(IDS.starter);
    expect(notes[0]).toMatchObject({ source: 'Skip Ratchet', body: 'Rest him Thursday.' });
    // Unsigned, it is the reader's own
    expect(notes[1].source).toBe('You');
    await expect(post('/api/player-notes', { player_id: IDS.starter, body: '  ' })).rejects.toThrow(/400/);
  });
});

describe('taking a player off the watchlist', () => {
  it('removes the row, and says so', async () => {
    await runChatTool('watch_player', { player_id: IDS.starter });
    const said = await runChatTool('unwatch_player', { player_id: IDS.starter });

    expect(said).toBe(`Took ${nameOf(IDS.starter)} off the watchlist.`);
    expect(watchRow(IDS.starter)).toBeUndefined();
  });

  it('says nothing changed when he was not on it', async () => {
    const said = await runChatTool('unwatch_player', { player_id: IDS.starter });

    expect(said).toMatch(/was not on the watchlist/i);
    expect(said).toMatch(/nothing changed/i);
  });

  it('leaves everyone else on the list', async () => {
    await runChatTool('watch_player', { player_id: IDS.starter });
    await runChatTool('watch_player', { player_id: IDS.lefty });
    await runChatTool('unwatch_player', { player_id: IDS.starter });

    expect(watchRow(IDS.lefty)).toBeTruthy();
  });
});

describe('filing a note', () => {
  const plan = 'Cap him at 75 pitches until he has made two starts.';

  it('files it on his page under the name of whoever is speaking', async () => {
    const said = await runChatTool('add_note', { player_id: IDS.starter, note: plan }, 'Drew Toussaint');

    expect(said).toBe(`Filed a note on ${nameOf(IDS.starter)}’s card.`);
    // Read back through the route the player card reads it from
    const { notes } = (await request(`/api/player-notes/${IDS.starter}`)) as { notes: Array<Record<string, unknown>> };
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: 'Drew Toussaint', body: plan, player_name: nameOf(IDS.starter) });
  });

  it('falls back to a plain name when it is not told who is speaking', async () => {
    await runChatTool('add_note', { player_id: IDS.starter, note: plan });

    expect(notesOn(IDS.starter)[0].source).toBe('Assistant');
  });

  it('files it trimmed', async () => {
    await runChatTool('add_note', { player_id: IDS.starter, note: `  ${plan}\n\n` });

    expect(notesOn(IDS.starter)[0].body).toBe(plan);
  });

  it('refuses an empty note, and one that is a whole essay', async () => {
    await expect(runChatTool('add_note', { player_id: IDS.starter, note: '   ' })).rejects.toThrow(/empty/i);
    await expect(runChatTool('add_note', { player_id: IDS.starter })).rejects.toThrow(/empty/i);
    await expect(
      runChatTool('add_note', { player_id: IDS.starter, note: 'x'.repeat(2001) })
    ).rejects.toThrow(/2001 characters/);
    expect(notesOn(IDS.starter)).toEqual([]);
  });

  it('refuses a man who is not in the save', async () => {
    await expect(runChatTool('add_note', { player_id: 987654, note: plan })).rejects.toThrow(/no player/i);
    expect(notesOn(987654)).toEqual([]);
  });

  /*
   * A room sends several voices at one request, and a model told a tool failed
   * will try it again. Neither should leave the same note on his card twice.
   */
  it('does not file the same note twice', async () => {
    await runChatTool('add_note', { player_id: IDS.starter, note: plan }, 'Peter');
    const again = await runChatTool('add_note', { player_id: IDS.starter, note: plan }, 'Drew Toussaint');

    expect(again).toMatch(/already on/i);
    expect(again).toMatch(/nothing added/i);
    expect(notesOn(IDS.starter)).toHaveLength(1);
  });

  it('files a different note on the same man', async () => {
    await runChatTool('add_note', { player_id: IDS.starter, note: plan });
    await runChatTool('add_note', { player_id: IDS.starter, note: 'Ask the trainer about the elbow.' });

    expect(notesOn(IDS.starter)).toHaveLength(2);
  });
});

/**
 * The whole path, with a model that is not one.
 *
 * Everything above calls the dispatcher directly. What it cannot show is the
 * wiring: that the chat offers these tools to the model at all, that the
 * dispatcher it runs is the one that knows them, that what a tool says is what
 * reaches the model, and that the reply it writes from that is what reaches the
 * reader. A tool defined and never offered, or offered and run through the
 * read-only dispatcher, passes every test above and does nothing.
 *
 * The model here is a local server speaking OpenAI wire format, which writes
 * its reply out of the tool result it was given. That is the property under
 * test: the confirmation is the true one because it comes from the tool.
 */
describe('through the chat', () => {
  interface Step {
    say?: string;
    call?: { name: string; args: Record<string, unknown> };
  }
  let model: Server;
  let modelUrl = '';
  const asked: any[] = [];
  let script: (n: number, body: any) => Step = () => ({ say: 'ok' });
  const wasEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.post('/v1/chat/completions', (req, res) => {
      const n = asked.push(req.body);
      const step = script(n, req.body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: 1, model: 'fake',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        );
      if (step.say !== undefined) chunk({ role: 'assistant', content: step.say });
      if (step.call) {
        chunk({
          role: 'assistant',
          tool_calls: [{
            index: 0, id: `call_${n}`, type: 'function',
            function: { name: step.call.name, arguments: JSON.stringify(step.call.args) },
          }],
        });
      }
      chunk({}, step.call ? 'tool_calls' : 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    model = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => model.once('listening', resolve));
    modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;

    // The SDK reads where to post from the environment, so nothing in the app knows this is a test
    for (const [name, value] of Object.entries({ OPENAI_BASE_URL: modelUrl, OPENAI_API_KEY: 'test-not-a-key' })) {
      wasEnv[name] = process.env[name];
      process.env[name] = value;
    }
    await post('/api/settings', { provider: 'openai', model: 'gpt-fake' });
  }, LIMIT);

  afterAll(async () => {
    await post('/api/settings', { provider: 'anthropic' });
    for (const [name, value] of Object.entries(wasEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  });

  beforeEach(() => {
    asked.length = 0;
  });

  /** One question to the analyst, read to the end. */
  async function converse(question: string): Promise<Array<{ event: string; data: any }>> {
    const res = await fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: IDS.mlbTeam,
        persona: 'analyst',
        messages: [{ role: 'user', content: question }],
      }),
    });
    const frames = (await res.text()).split('\n\n').filter(Boolean);
    return frames.map((f) => ({
      event: /^event: (.*)$/m.exec(f)![1],
      data: JSON.parse(/^data: (.*)$/m.exec(f)![1]),
    }));
  }
  const said = (events: Array<{ event: string; data: any }>) =>
    events.filter((e) => e.event === 'text').map((e) => e.data.delta).join('');
  /** What the last tool told the model, as the model received it. */
  const toldByTool = (body: any): string =>
    [...body.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '';

  it('offers the model the three tools that act, beside the ones that read', async () => {
    script = () => ({ say: 'Nothing to do.' });
    await converse('Anything new, acting test one?');

    const offered = asked[0].tools.map((t: any) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(['watch_player', 'unwatch_player', 'add_note']));
    expect(offered).toEqual(expect.arrayContaining(['search_players', 'get_player', 'get_roster']));
  }, LIMIT);

  it('tells the model, in its instructions, what the tools are for and where they stop', async () => {
    script = () => ({ say: 'Nothing to do.' });
    await converse('Anything new, acting test two?');

    const system = asked[0].messages[0].content as string;
    expect(system).toMatch(/watch_player/);
    // The prompt is wrapped for reading, so a phrase can fall across a line
    expect(system).toMatch(/nothing in OOTP\s+moves/i);
    expect(system).toMatch(/never on your own/i);
  }, LIMIT);

  it('lets the model watch a player, and the reply is the true account of it', async () => {
    script = (n, body) =>
      n === 1
        ? { call: { name: 'watch_player', args: { player_id: IDS.starter } } }
        // Written from what the tool said, which is what a model that is paying attention does
        : { say: `Done. ${toldByTool(body)}` };
    const events = await converse('Put him on my watchlist, acting test three.');

    expect(events.filter((e) => e.event === 'tool').map((e) => e.data.name)).toEqual(['watch_player']);
    expect(said(events)).toBe(`Done. Added ${nameOf(IDS.starter)} to the watchlist.`);
    expect(watchRow(IDS.starter)).toBeTruthy();
    expect(events.at(-1)?.event).toBe('done');
  }, LIMIT);

  it('files a note under the name of the person answering', async () => {
    const speaker = personaById(IDS.mlbTeam, 'analyst')!.name;
    script = (n) =>
      n === 1
        ? { call: { name: 'add_note', args: { player_id: IDS.starter, note: 'Revisit when he is back.' } } }
        : { say: 'Filed.' };
    await converse('Note that down, acting test four.');

    expect(notesOn(IDS.starter)).toHaveLength(1);
    expect(notesOn(IDS.starter)[0]).toMatchObject({ source: speaker, body: 'Revisit when he is back.' });
  }, LIMIT);

  it('hands the model the refusal when a tool will not do it, so it cannot claim it did', async () => {
    script = (n, body) =>
      n === 1
        ? { call: { name: 'watch_player', args: { player_id: 987654 } } }
        : { say: toldByTool(body) };
    const events = await converse('Put him on my watchlist, acting test five.');

    expect(said(events)).toMatch(/no player with player_id 987654/i);
    expect(watchRow(987654)).toBeUndefined();
  }, LIMIT);
});
