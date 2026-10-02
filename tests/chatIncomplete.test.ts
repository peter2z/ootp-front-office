import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  INCOMPLETE_EMPTY, INCOMPLETE_RAN_OUT, describeError, toolLoop, toolLoopFor,
  type ToolLoopOpts, type ToolLoopResult,
} from '../server/providers.js';
import { runToolLoop } from '../server/chat.js';
import { isIncompleteAnswer } from '../src/Chat.js';
import request, { post } from './request.js';
import { IDS } from './fixture.js';

/**
 * A tool loop that stops before it has an answer, whichever way it stops.
 *
 * "The assistant can read but never act ... Stop cancels the browser request
 * but not the model run", and "when the tool loop runs out of turns the verdict
 * can come back empty with no incomplete marker."
 *
 * Both used to look like success. A loop that spent its last turn on lookups
 * returned the empty string: the chat drew no bubble and the trade desk printed
 * a verdict with nothing in it, and neither said a question had been asked.
 * And Stop closed the browser request while the model run carried on behind
 * it, asking again, running tools and paying for an answer nobody was reading.
 *
 * Tested against a server that speaks each service wire format rather than
 * against a stand-in for its SDK, because the SDKs disagree about what an abort
 * even is. Anthropic raises its own error, Google fetch raises another, and
 * OpenAI stream raises nothing at all: it ends early and looks exactly like a
 * model that finished. A fake that raised on abort would have passed every test
 * below and proved nothing about the one SDK that does not.
 */

const LIMIT = 20_000;

type Wire = 'openai' | 'anthropic' | 'gemini';

/** What the model does when asked: write something, ask for tools, or both. */
interface Step {
  say?: string;
  calls?: Array<{ name: string; args?: Record<string, unknown> }>;
  /** Leave the response open after what is written, the way a stalled model does. */
  hang?: boolean;
  /** Refuse the request, the way Ollama does when it is asked for something it cannot do. */
  fail?: { status: number; message: string };
}

interface Fake {
  url: string;
  /** Every request, in the order it arrived. */
  calls: Array<{ wire: Wire; body: any; path: string; auth: string | undefined }>;
  /** Requests the client walked away from before they were answered. */
  dropped: number;
  /** What to do for the nth request, counting from one. */
  script: (n: number, body: any) => Step;
  /** How long to think before answering, so a loop has time to be caught mid-run. */
  delayMs: number;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for something another part of the process is doing, and says what it was waiting for. */
async function until(what: string, test: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > ms) throw new Error(`Gave up waiting for ${what}`);
    await sleep(10);
  }
}

/** One answer in each service own shape. Only the parts the loops read are written. */
const ENCODE: Record<Wire, (res: Response, step: Step, n: number, body: any) => void> = {
  openai(res, step, n) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    const chunk = (delta: object, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: 1, model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      );
    if (step.say !== undefined) chunk({ role: 'assistant', content: step.say });
    if (step.calls?.length) {
      chunk({
        role: 'assistant',
        tool_calls: step.calls.map((c, i) => ({
          index: i, id: `call_${n}_${i}`, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      });
    }
    if (step.hang) return;
    chunk({}, step.calls?.length ? 'tool_calls' : 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  },

  anthropic(res, step, n, body) {
    const calls = step.calls ?? [];
    const stopReason = calls.length ? 'tool_use' : 'end_turn';
    const message = {
      id: `msg_${n}`, type: 'message', role: 'assistant', model: 'fake',
      stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    };
    // The trade desk loop asks for one JSON reply; the chat asks for a stream
    if (!body.stream) {
      if (step.hang) return;
      res.json({
        ...message,
        stop_reason: stopReason,
        content: [
          ...(step.say ? [{ type: 'text', text: step.say }] : []),
          ...calls.map((c, i) => ({ type: 'tool_use', id: `toolu_${n}_${i}`, name: c.name, input: c.args ?? {} })),
        ],
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    const event = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null } });
    let index = 0;
    if (step.say) {
      event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index, delta: { type: 'text_delta', text: step.say } });
      if (!step.hang) event('content_block_stop', { index });
      index++;
    }
    for (const [i, c] of calls.entries()) {
      event('content_block_start', {
        index, content_block: { type: 'tool_use', id: `toolu_${n}_${i}`, name: c.name, input: {} },
      });
      event('content_block_delta', {
        index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.args ?? {}) },
      });
      event('content_block_stop', { index });
      index++;
    }
    if (step.hang) return;
    event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', {});
    res.end();
  },

  gemini(res, step) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    const parts = [
      ...(step.say !== undefined ? [{ text: step.say }] : []),
      ...(step.calls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } })),
    ];
    // A finish reason on the chunk is how Google says the turn is over
    res.write(
      `data: ${JSON.stringify({
        candidates: [{ index: 0, content: { role: 'model', parts }, ...(step.hang ? {} : { finishReason: 'STOP' }) }],
      })}\n\n`
    );
    if (!step.hang) res.end();
  },
};

async function startFake(): Promise<Fake> {
  const fake: Fake = {
    url: '',
    calls: [],
    dropped: 0,
    script: () => ({ say: 'ok' }),
    delayMs: 0,
    close: async () => {},
  };
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const answer = (wire: Wire, req: express.Request, res: Response): void => {
    const n = fake.calls.push({ wire, body: req.body, path: req.path, auth: req.headers.authorization });
    // Closed before it was answered is a request somebody gave up on
    res.on('close', () => {
      if (!res.writableFinished) fake.dropped++;
    });
    const step = fake.script(n, req.body);
    const reply = () => {
      if (res.destroyed) return;
      if (step.fail) {
        // The shape OpenAI answers in, which Ollama copies: the status on the response, the sentence inside
        res.status(step.fail.status).json({
          error: { message: step.fail.message, type: 'invalid_request_error', param: null, code: null },
        });
        return;
      }
      ENCODE[wire](res, step, n, req.body);
    };
    if (fake.delayMs > 0) setTimeout(reply, fake.delayMs);
    else reply();
  };
  app.post('/v1/chat/completions', (req, res) => answer('openai', req, res));
  // Ollama's address is a setting, so its loop is sent somewhere the OpenAI one is not
  app.post('/ollama/v1/chat/completions', (req, res) => answer('openai', req, res));
  app.post('/v1/messages', (req, res) => answer('anthropic', req, res));
  app.post('/v1beta/models/:action', (req, res) => answer('gemini', req, res));

  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise((resolve) => {
      // A stalled response holds its connection open, and close() waits for those
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}

let fake: Fake;

const lookup: Anthropic.Tool = {
  name: 'look_it_up',
  description: 'A stand-in lookup, so the loops have something to ask for.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

/** One loop run: what it was handed, and what it said and did along the way. */
interface Trial {
  opts: ToolLoopOpts;
  /** Text sent to the reader, in order. */
  said: string[];
  /** Tools it started, in order. */
  looked: string[];
  /** Pull this to press Stop. */
  stop: AbortController;
}

function trial(
  when: { stopOnText?: string; stopOnTool?: boolean; stopped?: boolean; runTool?: ToolLoopOpts['runTool'] } = {}
): Trial {
  const said: string[] = [];
  const looked: string[] = [];
  const stop = new AbortController();
  if (when.stopped) stop.abort();
  return {
    said, looked, stop,
    opts: {
      key: 'test-not-a-key',
      model: 'fake-model',
      system: 'You are a stand-in for the staff.',
      messages: [{ role: 'user', content: 'Who is hurt?' }],
      tools: [lookup],
      // Three turns is enough to run out of, without twelve round trips to do it
      maxTurns: 3,
      signal: stop.signal,
      onText: (delta) => {
        said.push(delta);
        if (when.stopOnText && said.join('').includes(when.stopOnText)) stop.abort();
      },
      onTool: (name) => {
        looked.push(name);
        if (when.stopOnTool) stop.abort();
      },
      runTool: when.runTool ?? (async () => '[]'),
    },
  };
}

interface Runner {
  name: string;
  /** What the script asks for. The chat has its own dispatcher, so it asks for a tool it really has. */
  tool: string;
  args: Record<string, unknown>;
  /** Whether text reaches the reader before the whole reply is in. The trade desk Anthropic loop waits. */
  streams: boolean;
  go: (o: ToolLoopOpts) => Promise<ToolLoopResult>;
}

const RUNNERS: Runner[] = [
  {
    name: 'the loop for OpenAI',
    tool: 'look_it_up', args: {}, streams: true,
    go: (o) => toolLoopFor('openai')!(o),
  },
  {
    name: 'the loop for Gemini',
    tool: 'look_it_up', args: {}, streams: true,
    go: (o) => toolLoopFor('gemini')!(o),
  },
  {
    name: 'the loop for Ollama',
    tool: 'look_it_up', args: {}, streams: true,
    go: (o) => toolLoopFor('ollama')!(o),
  },
  {
    name: 'the Anthropic loop the trade desk uses',
    tool: 'look_it_up', args: {}, streams: false,
    go: (o) => toolLoop('anthropic')(o),
  },
  {
    name: 'the staff chat on Anthropic',
    tool: 'unwatch_player', args: { player_id: IDS.starter }, streams: true,
    go: (o) =>
      runToolLoop({
        client: new Anthropic({ apiKey: 'test-not-a-key', baseURL: fake.url }),
        provider: 'anthropic',
        key: 'test-not-a-key',
        model: 'fake-model',
        thinking: undefined,
        system: [{ type: 'text', text: o.system }],
        messages: o.messages,
        send: (event, data) => {
          const d = data as { delta?: string; name?: string };
          if (event === 'text') o.onText(d.delta ?? '');
          if (event === 'tool') o.onTool(d.name ?? '');
        },
        signal: o.signal,
        maxTurns: o.maxTurns,
      }),
  },
];

const wasEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  fake = await startFake();
  // Each SDK reads where to post from the environment, which is how the real
  // loops reach this server without a line of the app knowing it is a test
  const point: Record<string, string> = {
    OPENAI_BASE_URL: `${fake.url}/v1`,
    ANTHROPIC_BASE_URL: fake.url,
    GOOGLE_GEMINI_BASE_URL: fake.url,
  };
  for (const [name, value] of Object.entries(point)) {
    wasEnv[name] = process.env[name];
    process.env[name] = value;
  }
  /*
   * Ollama is the one that is told where to post rather than reading it from the
   * environment, because the address is a setting. Saved the way the Settings
   * page saves it, so the road from the setting to the loop is the real one.
   */
  await post('/api/settings', { ollamaUrl: `${fake.url}/ollama/v1` });
}, LIMIT);

afterAll(async () => {
  for (const [name, value] of Object.entries(wasEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // An empty address puts the default back
  await post('/api/settings', { ollamaUrl: '' });
  await fake.close();
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.delayMs = 0;
});

describe.each(RUNNERS)('$name', (r) => {
  const asks = (): Step => ({ calls: [{ name: r.tool, args: r.args }] });

  it('says so when it runs out of turns, instead of coming back empty', async () => {
    fake.script = asks; // every reply is another lookup, so it never gets to write
    const t = trial();
    const out = await r.go(t.opts);

    expect(out.answer).toBe(INCOMPLETE_RAN_OUT);
    expect(out.refused).toBe(false);
    expect(fake.calls).toHaveLength(3);
    // Not only returned: the reader has to see it where the answer would have been
    expect(t.said.join('')).toBe(INCOMPLETE_RAN_OUT);
  }, LIMIT);

  it('is not fooled by narration written on the way to a lookup', async () => {
    // "Let me check" before every call, and never an answer: still nothing was answered
    fake.script = () => ({ say: 'Checking.', calls: [{ name: r.tool, args: r.args }] });
    const t = trial();
    const out = await r.go(t.opts);

    // How much of the narration comes back differs between the loops; the note must not
    expect(out.answer.endsWith(INCOMPLETE_RAN_OUT)).toBe(true);
    expect(t.said.join('').endsWith(INCOMPLETE_RAN_OUT)).toBe(true);
  }, LIMIT);

  it('says so when the model ends on an empty message', async () => {
    fake.script = (n) => (n === 1 ? asks() : { say: '' });
    const t = trial();
    const out = await r.go(t.opts);

    // A different failure from running out, and not blamed on the lookups
    expect(out.answer).toBe(INCOMPLETE_EMPTY);
    expect(fake.calls).toHaveLength(2);
    expect(t.said.join('')).toBe(INCOMPLETE_EMPTY);
  }, LIMIT);

  it('leaves a real answer exactly as it was written', async () => {
    fake.script = (n) => (n === 1 ? asks() : { say: 'He is day to day.' });
    const t = trial();
    const out = await r.go(t.opts);

    expect(out.answer).toBe('He is day to day.');
    expect(t.said.join('')).toBe('He is day to day.');
  }, LIMIT);

  it('runs as before for a caller that has no way to stop it', async () => {
    // The trade desk hands the loops no signal, and has to keep working without one
    fake.script = (n) => (n === 1 ? asks() : { say: 'He is day to day.' });
    const t = trial();
    delete t.opts.signal;
    const out = await r.go(t.opts);

    expect(out.answer).toBe('He is day to day.');
    expect(fake.calls).toHaveLength(2);
  }, LIMIT);

  it('stops asking when it is stopped mid-answer, and cancels the request in flight', async () => {
    fake.script = (n) => (n === 1 ? asks() : { say: 'Let me see', hang: true });
    const before = fake.dropped;
    const t = trial({ stopOnText: r.streams ? 'Let me see' : undefined });
    const running = r.go(t.opts);
    // Without partial text to react to, stop once the request is known to be in flight
    if (!r.streams) void until('the second request', () => fake.calls.length >= 2).then(() => t.stop.abort());

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    // The point of the signal: the provider is told, not merely left unread
    await until('the request to the model to be dropped', () => fake.dropped > before);
    expect(fake.calls).toHaveLength(2);
  }, LIMIT);

  it('does not ask again when it is stopped while a tool is running', async () => {
    fake.script = asks;
    const t = trial({ stopOnTool: true });

    await expect(r.go(t.opts)).rejects.toMatchObject({ name: 'AbortError' });
    // The lookup in hand finishes, since nothing can un-run it, and that is all
    expect(fake.calls).toHaveLength(1);
  }, LIMIT);

  it('does not start at all if it has already been stopped', async () => {
    fake.script = asks;
    const t = trial({ stopped: true });

    await expect(r.go(t.opts)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls).toHaveLength(0);
    expect(t.looked).toEqual([]);
  }, LIMIT);
});

describe('a batch of tools, stopped part of the way through', () => {
  /*
   * The case that matters once the assistant can change things: two tool calls
   * in one reply, Stop pressed during the first. The first cannot be un-run;
   * the second must not be started.
   */
  it('does not start the ones that have not begun', async () => {
    fake.script = () => ({ calls: [{ name: 'look_it_up' }, { name: 'look_it_up' }] });
    let ran = 0;
    const t = trial({
      stopOnTool: true,
      runTool: async () => {
        ran++;
        return '[]';
      },
    });

    await expect(toolLoopFor('openai')!(t.opts)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ran).toBe(1);
    expect(fake.calls).toHaveLength(1);
  }, LIMIT);
});

/** The events of one chat response as they arrive, so a test can act in the middle of one. */
async function* events(res: globalThis.Response): AsyncGenerator<{ event: string; data: any }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}

/** The chat route, asked the way the page asks it. The server is started by the first request to it. */
const ask = (question: string, signal?: AbortSignal) =>
  fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orgId: IDS.mlbTeam,
      persona: 'analyst',
      messages: [{ role: 'user', content: question }],
    }),
    signal,
  });

/**
 * The same thing from the browser, through the real route.
 *
 * Everything above hands a loop a signal directly. This is the part nothing
 * else covers: that closing the request is what produces one. A reader presses
 * Stop, fetch is aborted, the connection drops, and the server has to notice
 * from nothing but that.
 */
describe('Stop, from the browser', () => {
  beforeAll(async () => {
    await request('/api/status'); // starts the server the chat route lives on
    wasEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-not-a-key';
    await post('/api/settings', { provider: 'openai', model: 'gpt-fake' });
  }, LIMIT);

  afterAll(async () => {
    await post('/api/settings', { provider: 'anthropic' });
    if (wasEnv.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = wasEnv.OPENAI_API_KEY;
  });

  it('cancels the request the model is in the middle of', async () => {
    fake.script = (n) => (n === 1 ? { calls: [{ name: 'get_teams' }] } : { say: 'Let me see', hang: true });
    const before = fake.dropped;
    const stop = new AbortController();
    const res = await ask('Who is hurt, stop test one?', stop.signal);

    for await (const e of events(res)) {
      // The second request is under way and the model has begun to write: this is Stop
      if (e.event === 'text') {
        stop.abort();
        break;
      }
    }
    // Without the fix this never happens: the server keeps waiting on a model nobody is listening to
    await until('the request to the model to be dropped', () => fake.dropped > before);
    expect(fake.calls).toHaveLength(2);
  }, LIMIT);

  it('does not go on asking once the reader has gone', async () => {
    // Slow enough that a loop left running is still running when this looks
    fake.script = () => ({ calls: [{ name: 'get_teams' }] });
    fake.delayMs = 80;
    const stop = new AbortController();
    const res = await ask('Who is hurt, stop test two?', stop.signal);

    for await (const e of events(res)) {
      if (e.event === 'tool') {
        stop.abort();
        break;
      }
    }
    await sleep(300);
    const settled = fake.calls.length;
    await sleep(700);
    // Twelve turns at 80ms is about a second: a loop that carried on would still be counting
    expect(fake.calls.length).toBe(settled);
    expect(settled).toBeLessThan(12);
  }, LIMIT);

  it('is not mistaken for the end of a run that finished', async () => {
    fake.script = (n) => (n === 1 ? { calls: [{ name: 'get_teams' }] } : { say: 'All quiet.' });
    const seen: Array<{ event: string; data: any }> = [];
    for await (const e of events(await ask('Who is hurt, stop test three?'))) seen.push(e);

    expect(seen.filter((e) => e.event === 'text').map((e) => e.data.delta).join('')).toBe('All quiet.');
    expect(seen.at(-1)?.event).toBe('done');
  }, LIMIT);

  it('puts the incomplete note in the window when the turns run out', async () => {
    fake.script = () => ({ calls: [{ name: 'get_teams' }] });
    const seen: Array<{ event: string; data: any }> = [];
    for await (const e of events(await ask('Who is hurt, stop test four?'))) seen.push(e);

    // The chat allows twelve asks; the twelfth is answered with a lookup like the rest
    expect(fake.calls).toHaveLength(12);
    expect(seen.filter((e) => e.event === 'text').map((e) => e.data.delta).join('')).toBe(INCOMPLETE_RAN_OUT);
    expect(seen.at(-1)?.event).toBe('done');
  }, LIMIT);
});

/**
 * The staff chat and the trade desk, on a model from this machine.
 *
 * The 0.40 release put Ollama in Settings, and the AI features that make one
 * call (the newspaper, the briefing, the storylines) ran on it. The two that
 * hand the model tools did not. Picking Ollama sent the chat to "No
 * implementation for provider ollama", and sent the trade desk to the Anthropic
 * loop with the placeholder key where a real one goes, so what came back was a
 * complaint about a key the reader never had.
 *
 * The fake here stands in for Ollama as the other fakes stand in for the
 * paid services: it speaks the OpenAI wire, at an address of its own that only
 * the Settings page knows. The behaviours every loop shares are run against
 * Ollama in the list further up; this is what is particular to it.
 */
describe('the loop for Ollama', () => {
  const OLLAMA_PATH = '/ollama/v1/chat/completions';

  /** Ollama's own words for a model that was not built to take tools. */
  const noTools = (model: string): Step => ({
    fail: { status: 400, message: `registry.ollama.ai/library/${model} does not support tools` },
  });

  const forModel = (model: string, when?: Parameters<typeof trial>[0]): Trial => {
    const t = trial(when);
    t.opts.model = model;
    return t;
  };

  it('posts to the address in Settings, not to OpenAI', async () => {
    fake.script = () => ({ say: 'He is day to day.' });
    const out = await toolLoopFor('ollama')!(forModel('llama3.1:8b').opts);

    expect(out.answer).toBe('He is day to day.');
    // The environment in this file also points OpenAI at the fake, on another path
    expect(fake.calls.map((c) => c.path)).toEqual([OLLAMA_PATH]);
  }, LIMIT);

  it('asks for the model that was chosen, with the tools, as a stream', async () => {
    fake.script = () => ({ say: 'ok' });
    await toolLoopFor('ollama')!(forModel('qwen2.5:14b').opts);

    const body = fake.calls[0].body;
    expect(body.model).toBe('qwen2.5:14b');
    expect(body.stream).toBe(true);
    expect(body.tools.map((t: any) => t.function.name)).toEqual(['look_it_up']);
  }, LIMIT);

  it('sends the placeholder, never a key held for some other service', async () => {
    fake.script = () => ({ say: 'ok' });
    const t = forModel('llama3.1:8b');
    t.opts.key = 'sk-ant-NOT-A-REAL-KEY-for-this-test';
    await toolLoopFor('ollama')!(t.opts);

    // The address is a setting, so this is the one place a stray key could be posted somewhere odd
    expect(fake.calls[0].auth).toBe('Bearer ollama');
  }, LIMIT);

  it('is what the trade desk gets as well, in place of the Anthropic loop', async () => {
    fake.script = (n) => (n === 1 ? { calls: [{ name: 'look_it_up' }] } : { say: 'Reject.' });
    const t = forModel('llama3.1:8b');
    const out = await toolLoop('ollama')(t.opts);

    expect(out.answer).toBe('Reject.');
    expect(t.looked).toEqual(['look_it_up']);
    expect(fake.calls.map((c) => [c.wire, c.path])).toEqual([
      ['openai', OLLAMA_PATH],
      ['openai', OLLAMA_PATH],
    ]);
  }, LIMIT);

  it('says what to do when no model has been chosen, and asks nothing of Ollama', async () => {
    await expect(toolLoopFor('ollama')!(forModel('  ').opts)).rejects.toThrow(
      /No local model chosen\. Pick one in Settings/
    );
    expect(fake.calls).toHaveLength(0);
  }, LIMIT);

  describe('a model with no tool support', () => {
    for (const [entry, run] of [
      ['the staff chat loop', (o: ToolLoopOpts) => toolLoopFor('ollama')!(o)],
      ['the trade desk entry', (o: ToolLoopOpts) => toolLoop('ollama')(o)],
    ] as const) {
      it(`is put in plain words for the reader, naming the model (${entry})`, async () => {
        fake.script = () => noTools('gemma2:9b');
        const failure = await run(forModel('gemma2:9b').opts).catch((e: unknown) => e);

        expect(failure).toBeInstanceOf(Error);
        const said = (failure as Error).message;
        expect(said).toContain('The model "gemma2:9b" does not support tools');
        expect(said).toContain('Pick a model that supports tools in Settings');
        // None of what the SDK made of the response: a status, the registry path, a JSON body
        expect(said).not.toMatch(/\b400\b|registry\.ollama\.ai|[{}]/);
        // Asked once and not again: there is nothing to retry, and nothing to loop on
        expect(fake.calls).toHaveLength(1);
        // And it survives the translation both callers put every error through
        expect(describeError('ollama', failure)).toBe(said);
      }, LIMIT);
    }

    it('is not the answer to some other 400', async () => {
      // A history Ollama cannot parse is a bug to be seen as it is, not a reason to pick another model
      fake.script = () => ({ fail: { status: 400, message: 'invalid message content type: <nil>' } });
      const failure = await toolLoopFor('ollama')!(forModel('llama3.1:8b').opts).catch((e: unknown) => e);

      expect((failure as Error).message).toMatch(/invalid message content type/);
      expect((failure as Error).message).not.toMatch(/Pick a model/);
    }, LIMIT);

    it('is not the answer to the same words under another status', async () => {
      // Something along the way, a proxy say, repeating what it was told
      fake.script = () => ({ fail: { status: 404, message: 'upstream said gemma2:9b does not support tools' } });
      const failure = await toolLoopFor('ollama')!(forModel('llama3.1:8b').opts).catch((e: unknown) => e);

      expect((failure as { status?: number }).status).toBe(404);
      expect((failure as Error).message).not.toMatch(/Pick a model/);
    }, LIMIT);
  });
});

/**
 * Through the real routes, with Ollama chosen in Settings the way a reader
 * chooses it.
 */
describe('the staff chat, on Ollama', () => {
  const OLLAMA_PATH = '/ollama/v1/chat/completions';

  const useModel = (model: string) => post('/api/settings', { provider: 'ollama', model });

  beforeAll(async () => {
    await request('/api/status'); // starts the server the chat route lives on
    await useModel('llama3.1:8b');
  }, LIMIT);

  afterAll(async () => {
    await post('/api/settings', { provider: 'anthropic' });
  });

  async function chat(question: string): Promise<Array<{ event: string; data: any }>> {
    const seen: Array<{ event: string; data: any }> = [];
    for await (const e of events(await ask(question))) seen.push(e);
    return seen;
  }
  const said = (seen: Array<{ event: string; data: any }>) =>
    seen.filter((e) => e.event === 'text').map((e) => e.data.delta).join('');

  it('answers, looking things up on the way, where it used to give up', async () => {
    fake.script = (n) => (n === 1 ? { calls: [{ name: 'get_teams' }] } : { say: 'All quiet.' });
    const seen = await chat('Who is hurt, ollama test one?');

    expect(seen.find((e) => e.event === 'error')).toBeUndefined();
    expect(seen.filter((e) => e.event === 'tool').map((e) => e.data.name)).toEqual(['get_teams']);
    expect(said(seen)).toBe('All quiet.');
    expect(seen.at(-1)?.event).toBe('done');
    // To Ollama, at the address saved in Settings, for the model chosen there
    expect(fake.calls.map((c) => c.path)).toEqual([OLLAMA_PATH, OLLAMA_PATH]);
    expect(fake.calls[0].body.model).toBe('llama3.1:8b');
  }, LIMIT);

  it('is given the tools that change things, the same as on any other service', async () => {
    fake.script = () => ({ say: 'ok' });
    await chat('Who is hurt, ollama test two?');

    const offered = fake.calls[0].body.tools.map((t: any) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(['get_player', 'watch_player', 'unwatch_player', 'add_note']));
  }, LIMIT);

  it('says to pick another model when this one cannot use tools', async () => {
    await useModel('gemma2:9b');
    fake.script = () => ({
      fail: { status: 400, message: 'registry.ollama.ai/library/gemma2:9b does not support tools' },
    });
    const seen = await chat('Who is hurt, ollama test three?');
    await useModel('llama3.1:8b');

    const error = seen.find((e) => e.event === 'error');
    expect(error?.data.message).toMatch(/The model "gemma2:9b" does not support tools/);
    expect(error?.data.message).toMatch(/Pick a model that supports tools in Settings/);
    // What the reader used to be told, for want of a loop to run
    expect(error?.data.message).not.toMatch(/No implementation/);
    expect(said(seen)).toBe('');
  }, LIMIT);
});

/**
 * The trade desk reads and judges and has no business changing anything, and
 * what matters here is that it still cannot on a model of this kind either.
 */
describe('the trade desk, on Ollama', () => {
  const evaluate = () =>
    fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/trade/ai-eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: IDS.mlbTeam,
        orgLabel: 'the Test Club',
        sideA: [IDS.starter],
        sideB: [IDS.lefty],
      }),
    });

  beforeAll(async () => {
    await request('/api/status');
    await post('/api/settings', { provider: 'ollama', model: 'llama3.1:8b' });
  }, LIMIT);

  afterAll(async () => {
    await post('/api/settings', { provider: 'anthropic' });
  });

  it('gives its verdict, from Ollama, with the tools that only read', async () => {
    fake.script = (n) => (n === 1 ? { calls: [{ name: 'get_teams' }] } : { say: '**Verdict:** Reject.' });
    const res = await evaluate();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.verdict).toBe('**Verdict:** Reject.');
    expect(fake.calls.map((c) => [c.wire, c.path])).toEqual([
      ['openai', '/ollama/v1/chat/completions'],
      ['openai', '/ollama/v1/chat/completions'],
    ]);
    const offered: string[] = fake.calls[0].body.tools.map((t: any) => t.function.name);
    expect(offered).toContain('get_player');
    expect(offered.filter((n) => /^(watch|unwatch|add)_/.test(n))).toEqual([]);
  }, LIMIT);

  it('tells the reader to pick another model when this one cannot use tools', async () => {
    await post('/api/settings', { provider: 'ollama', model: 'gemma2:9b' });
    fake.script = () => ({
      fail: { status: 400, message: 'registry.ollama.ai/library/gemma2:9b does not support tools' },
    });
    const res = await evaluate();
    const body = await res.json();
    await post('/api/settings', { provider: 'ollama', model: 'llama3.1:8b' });

    expect(res.status).toBe(500);
    expect(body.error).toMatch(/The model "gemma2:9b" does not support tools/);
    expect(body.error).toMatch(/Pick a model that supports tools in Settings/);
  }, LIMIT);
});

/**
 * What the page does with an answer that never got written.
 *
 * It offers to save every answer to a player's file, and the incomplete note
 * is not one worth saving: it is a message to the reader about the run. The
 * page recognises the note by its text, which the server writes, so the two
 * are checked against each other here rather than trusted to agree.
 */
describe('the page, on an answer that never got written', () => {
  it('knows the note either loop writes, on its own', () => {
    expect(isIncompleteAnswer(INCOMPLETE_RAN_OUT)).toBe(true);
    expect(isIncompleteAnswer(INCOMPLETE_EMPTY)).toBe(true);
  });

  it('knows it behind narration the model wrote on the way to its lookups', () => {
    expect(isIncompleteAnswer(`Checking the roster.\n\n${INCOMPLETE_RAN_OUT}`)).toBe(true);
  });

  it('leaves an answer alone, even one that mentions the word', () => {
    expect(isIncompleteAnswer('He is day to day.')).toBe(false);
    expect(isIncompleteAnswer('The file reads [Incomplete: so far] in places, but the rest is fine.')).toBe(false);
    expect(isIncompleteAnswer('')).toBe(false);
  });
});
