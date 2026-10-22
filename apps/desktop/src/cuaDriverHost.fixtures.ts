// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
// The fake driver harness shared by the cuaDriverHost.*.test.ts suites. They are
// separate files so their mostly sleeping tests can run in parallel workers.
import { expect } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CuaDriverHost } from "./cuaDriverHost.ts";
import type { ComputerInputMonitorState } from "./escapeKillSwitchMonitor.ts";
import {
  cuaRequest as rawCuaRequest,
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
} from "@ryco/shared/cuaDriverProtocol";
export const capability = "isolated-fixture-authority-00000000000000";
export const cuaRequest: typeof rawCuaRequest = (path, request, options) =>
  rawCuaRequest(path, { ...(request as object), capability }, options);
const cleanups: Array<() => Promise<unknown>> = [];
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
/** Each suite runs this after every test: it disposes hosts and kills fake drivers. */
export async function cleanupFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
export async function fixture(
  authority = capability,
  options: {
    platform?: "darwin" | "linux";
    cleanup?: "incomplete" | "wrong-pid" | "missing-admission";
    interruptCleanup?: "incomplete" | "wrong-pid" | "missing-admission" | "once-incomplete";
    inputMonitorState?: (() => ComputerInputMonitorState) | undefined;
    activateInputMonitor?: () => Promise<void>;
    onInputMonitorArmedChange?: (armed: boolean) => void;
    unpatched?: boolean;
    nativeRevision?: number | null;
    reportedRevision?: number;
    browserInputControl?: unknown;
    metadataPidOffset?: number;
    metadataDelayMs?: number;
    failAction?: boolean;
    actionResult?: Record<string, unknown>;
    cursorUnavailable?: boolean;
    logCursorState?: boolean;
    cursorEnableFailures?: number;
    cursorHideFailures?: number;
    crash?: boolean;
    sessionDeathOnce?: boolean;
    sessionDeathTransport?: boolean;
    // Opt-in: logs `session:`/`open_session:` lines for the label each call
    // rides. Off by default so full-event-list assertions in older tests are
    // not polluted by the added instrumentation.
    logSessions?: boolean;
    browserRefusal?: boolean;
    browserHang?: boolean;
    browserCleanupUnconfirmed?: boolean;
    browserObservations?: boolean;
    inputDelayMs?: number;
    delayBrowserObservation?: boolean;
    delayObservation?: boolean;
    delayListWindowsMs?: number;
    hangSession?: boolean;
    dropCancel?: boolean;
    startupTimeoutMs?: number;
    deathFlag?: string;
    ownPids?: () => ReadonlySet<number>;
    cursorStyle?: () => { fill?: string; rim?: string; shadow?: string } | null | undefined;
    checkPermissions?: (options?: { readonly force: boolean }) => Promise<{
      accessibility: boolean;
      screenRecording: boolean;
      inputMonitoring?: boolean;
    }>;
    releaseHeldInput?: () => Promise<void>;
    frameTap?: {
      update: (target: unknown) => void;
      endTask: (task: unknown) => Promise<void>;
      stop: () => Promise<void>;
      dispose: () => Promise<void>;
    };
    shield?: {
      engage: (request: unknown, task?: unknown) => Promise<void>;
      release: (shieldId: string) => Promise<void>;
      releaseAll: () => Promise<number>;
      endTask: (task: unknown) => Promise<void>;
      stop: () => Promise<void>;
      dispose: () => Promise<void>;
    };
    listWindows?: Array<Record<string, unknown>>;
    // A separately loaded copy of the module, for tests of process-wide state.
    hostClass?: typeof CuaDriverHost;
  } = {},
) {
  // Model the driver's platform explicitly, independently of the CI runner.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: options.platform ?? "darwin" });
  cleanups.push(async () => {
    Object.defineProperty(process, "platform", platformDescriptor);
  });
  const directory = await mkdtemp(join(tmpdir(), "synara-cua-host-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "events.jsonl");
  const binary = join(directory, "driver");
  options = { ...options, deathFlag: join(directory, "session-died") };
  await writeFile(
    binary,
    `#!${process.execPath}
const net=require('node:net'),fs=require('node:fs');
const log=${JSON.stringify(log)}, options=${JSON.stringify(options)};
const write=event=>fs.appendFileSync(log,JSON.stringify({event,pid:process.pid,time:Date.now()})+'\\n');
write('start');
if(!options.unpatched){
  if(!process.argv.includes('--compact-cursor')) throw new Error('Missing compact cursor profile');
  if(process.argv[process.argv.indexOf('--idle-hide-ms')+1]!=='60000') throw new Error('Missing cursor idle deadline');
}
if(options.unpatched&&(process.argv.includes('--compact-cursor')||process.argv.includes('--idle-hide-ms'))) throw new Error('Upstream driver cannot parse Synara cursor flags');
const socket=process.argv[process.argv.indexOf('--socket')+1];
let action, timer, inputEpoch=0, interruptions=0, browserCleanupPending=false, cursorEnables=0, cursorHides=0;
net.createServer(s=>{
  const reply=result=>s.end(JSON.stringify({ok:true,result})+'\\n');
  s.once('data',b=>{
    const r=JSON.parse(b.toString());
    if(options.logSessions&&r.method==='call'&&r.args&&typeof r.args.session==='string') write('session:'+r.args.session+':'+r.name);
    if(r.method==='metadata') setTimeout(()=>reply({driver_version:${JSON.stringify(CUA_DRIVER_VERSION)},synara_native_revision:options.reportedRevision??(options.unpatched?undefined:${CUA_NATIVE_REVISION}),synara_browser_input_control:options.browserInputControl,embedded:true,pid:process.pid+(options.metadataPidOffset??0)}),options.metadataDelayMs??0);
    else if(r.method==='interrupt_input') {
      write('interrupt');
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong interrupt generation');
      inputEpoch++; interruptions++;
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'interrupted'})+'\\n'); action=undefined; }
      const incomplete=browserCleanupPending||options.interruptCleanup==='incomplete'||(options.interruptCleanup==='once-incomplete'&&interruptions===1);
      setTimeout(()=>{
        write('interrupt-ack');
        reply({pid:process.pid+(options.interruptCleanup==='wrong-pid'?1:0),input_interrupted:true,input_admission_open:options.interruptCleanup==='missing-admission'?undefined:!incomplete,cleanup_complete:!incomplete,pending_input:incomplete?1:0,input_epoch:inputEpoch});
      },30);
    }
    else if(r.method==='cancel_input') {
      write('cancel');
      if(options.dropCancel) { s.destroy(); return; }
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong generation');
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'cancelled'})+'\\n'); action=undefined; }
      setTimeout(()=>{
        write('cleanup-ack');
        reply({pid:process.pid+(options.cleanup==='wrong-pid'?1:0),input_admission_closed:options.cleanup==='missing-admission'?undefined:true,cleanup_complete:!browserCleanupPending&&options.cleanup!=='incomplete',pending_input:browserCleanupPending||options.cleanup==='incomplete'?1:0});
      },30);
    }
    else if(options.sessionDeathOnce && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && r.name!=='set_agent_cursor_style' && r.name!=='set_agent_cursor_enabled' && r.name!=='get_agent_cursor_state' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); reply({isError:true, content:[{type:'text', text:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id."}], structuredContent:{effect:'not-dispatched'}}); }
    else if(options.sessionDeathTransport && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && r.name!=='set_agent_cursor_style' && r.name!=='set_agent_cursor_enabled' && r.name!=='get_agent_cursor_state' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); s.end(JSON.stringify({ok:false,error:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.",effect:'not-dispatched'})+'\\n'); }
    else if(r.name==='type_text') {
      if(!options.unpatched&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      write('dispatch'); action=s;
      if(options.crash) { write('crash'); process.exit(1); }
      else if(options.failAction) s.destroy();
      else timer=setTimeout(()=>{write('effect');reply({});action=undefined},options.inputDelayMs??10000);
    }
    else if(options.hangSession && r.name==='start_session' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag,'1'); write('session-hang'); }
    else if(r.name==='set_agent_cursor_motion') { write('motion-'+r.args.glide_duration_ms+'-'+r.args.dwell_after_click_ms); reply({}); }
    else if(r.name==='set_agent_cursor_style') { write('style:'+JSON.stringify(r.args)); reply({}); }
    else if(r.name==='set_agent_cursor_enabled') {
      if(options.logCursorState) write('cursor-enabled:'+r.args.enabled+':'+r.args.session);
      const failed=r.args.enabled?cursorEnables++<(options.cursorEnableFailures??0):cursorHides++<(options.cursorHideFailures??0);
      reply(failed?{isError:true}:{});
    }
    else if(r.name==='get_agent_cursor_state') {
      if(options.logCursorState) write('cursor-state:'+r.args.session);
      reply(options.cursorUnavailable?{isError:true,content:[{type:'text',text:'private overlay error'}]}:{structuredContent:{session:r.args.session,enabled:true,position:{x:10,y:20},motion:{idle_hide_ms:60000},overlay_ready:true,render_visible:true,overlay_scope:'main_display'}});
    }
    else if(options.browserInputControl===1&&['clipboard_read','clipboard_write','kill_app','move_cursor'].includes(r.name)) {
      if(r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      write('permitted-native:'+r.name); reply({});
    }
    else if(r.name==='press_key') { if(!options.unpatched&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; } write('key'); write('observation-budget-'+process.env.SYNARA_CUA_FOREGROUND_OBSERVATION_MS); reply(options.actionResult??{}); }
    else if(r.name==='get_window_state' && !r.args?.empty) { write('observe'); setTimeout(()=>reply({structuredContent:{elements:r.args?.fixture_usable?[{role:"AXWindow"}]:[],window_is_on_screen:r.args?.fixture_usable===true,window_on_current_space:r.args?.fixture_usable===true,degraded:r.args?.fixture_degraded,screenshot_frame_valid:r.args?.fixture_stale!==true,pid:r.args?.pid,window_id:r.args?.fixture_wrong_window?99999:r.args?.window_id}}),options.delayObservation?60:0); }
    else if(r.name==='get_desktop_state') reply({content:[{type:'image',data:'fixture-image'}]});
    else if(r.name==='list_windows') { write('list-windows'); setTimeout(()=>{reply({structuredContent:{windows:options.listWindows||[]}});if(options.delayListWindowsMs) write('list-windows-replied');},options.delayListWindowsMs??0); }
    // Browser family observability: the persistent control connection opens
    // with session_begin; lifecycle calls attributed to a transport session
    // are the browser path (the desktop start_session carries no session_id).
    // session_begin replies without s.end: the real driver holds the control
    // connection open — its lifetime is what the transport session rides on.
    else if(r.method==='session_begin') { write('session-begin:'+r.session_id); s.write(JSON.stringify({ok:true,result:{session_begin:true}})+'\\n'); }
    else if((r.name==='start_session'||r.name==='end_session')&&r.session_id) { write(r.name+':'+r.args.session+':'+r.session_id); reply({}); }
    // Lifecycle calls without a transport envelope: the generation's own
    // openSession start_session and a task-label revival. Distinct event name
    // keeps them out of the browser lifecycle assertions above.
    else if(options.logSessions&&(r.name==='start_session'||r.name==='end_session')) { write('open_session:'+r.name+':'+r.args.session); reply({}); }
    else if(r.name==='start_session'||r.name==='end_session') { reply({}); }
    else if(r.name&&(r.name.indexOf('browser_')===0||r.name==='get_browser_state')) {
      write('browser:'+r.name+':'+(r.args&&r.args.session)+':'+(r.session_id||'-'));
      if(r.name.indexOf('browser_')===0&&(!options.unpatched||options.browserInputControl===1)&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      if(options.browserObservations&&r.name==='get_browser_state') {
        if(r.args?.target_id) {
          write('browser-observe');
          const data={status:'ok',mode:r.args.fixture_bind_only?'bind':'snapshot',target_id:r.args.fixture_wrong_target?'wrong-target':r.args.target_id,tab_id:r.args.tab_id,refs:[]};
          if(r.args.snapshot_format==='semantic_v2') data.snapshot={id:'p1'}; else data.snapshot_id='p1';
          setTimeout(()=>reply({structuredContent:data}),options.delayBrowserObservation?60:0);
        } else reply({structuredContent:{status:'ok',mode:'bind',binding_quality:'exact',mutation_allowed:true,target_id:r.args.fixture_target_id||'target-'+r.args.pid+'-'+r.args.window_id,tabs:[]}});
      }
      else if(options.browserHang&&r.name==='browser_type') { write('browser-dispatch'); action=s; timer=setTimeout(()=>{write('browser-effect'); reply({}); action=undefined},options.inputDelayMs??10000); }
      else if(options.browserCleanupUnconfirmed&&r.name==='browser_type') { browserCleanupPending=true; reply({isError:true,structuredContent:{input_cleanup_unconfirmed:true,effect:'unverifiable'}}); }
      else reply(options.browserRefusal?{structuredContent:{status:'refused',refusal:{code:'browser_requires_setup'}},content:[{type:'text',text:'refused (browser_requires_setup)'}]}:{});
    }
    else reply({});
  });
  s.on('error',()=>{});
}).listen(socket);
let retiring=false;
function retire(){if(retiring)return;retiring=true;write('retiring');setTimeout(()=>{write('exit');process.exit(0)},150)}
process.on('SIGTERM',retire);
process.stdin.resume(); process.stdin.on('end',retire);
`,
  );
  await chmod(binary, 0o755);
  const host = new (options.hostClass ?? CuaDriverHost)({
    binaryPath: binary,
    bundleId: "fixture",
    capability: authority,
    setup: async () => {},
    ...(options.checkPermissions ? { checkPermissions: options.checkPermissions } : {}),
    ...(options.releaseHeldInput ? { releaseHeldInput: options.releaseHeldInput } : {}),
    ...(options.inputMonitorState ? { inputMonitorState: options.inputMonitorState } : {}),
    ...(options.activateInputMonitor ? { activateInputMonitor: options.activateInputMonitor } : {}),
    ...(options.onInputMonitorArmedChange
      ? { onInputMonitorArmedChange: options.onInputMonitorArmedChange }
      : {}),
    ...(options.frameTap ? { frameTap: options.frameTap } : {}),
    ...(options.shield ? { shield: options.shield } : {}),
    ...(options.startupTimeoutMs ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.nativeRevision !== undefined ? { nativeRevision: options.nativeRevision } : {}),
    ...(options.ownPids ? { ownPids: options.ownPids } : {}),
    ...(options.cursorStyle ? { cursorStyle: options.cursorStyle } : {}),
  });
  const events = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
  cleanups.push(async () => {
    try {
      await host.dispose();
    } catch (error) {
      if (!options.cleanup && !options.crash && !options.browserCleanupUnconfirmed) throw error;
    }
    // These are fake executables created by this test, with no OS input API.
    // A deliberately invalid cleanup acknowledgement must leave them alive.
    for (const event of await events().catch(() => [])) {
      if (event.event === "start") {
        try {
          process.kill(event.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
  });
  const endpoint = await host.listen();
  return { host, endpoint, events };
}
/**
 * Physical input while the agent drives the real cursor and keyboard: the one
 * collision that still interrupts, and so the way into native takeover.
 */
export async function foregroundCollision(
  f: Awaited<ReturnType<typeof fixture>>,
  task: { threadId: string; turnId: string },
  target: { pid: number; window_id: number },
): Promise<void> {
  const typing = cuaRequest(
    f.endpoint,
    {
      method: "call",
      name: "type_text",
      args: { ...target, delivery_mode: "foreground", text: "fixture" },
      task,
    },
    { mutation: true },
  );
  await waitForEvent(f, "dispatch");
  expect(
    f.host.physicalInput({
      type: "physical-input",
      kind: "pointer",
      pid: target.pid,
      windowId: target.window_id,
    }),
  ).toBe(true);
  await expect(typing).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
  await waitForEvent(f, "interrupt-ack");
}

/** Wait for a real driver event; a missed barrier must fail the test. */
export async function waitForEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  event: string,
): Promise<Array<{ event: string; pid: number; time: number }>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const events = await f
      .events()
      .catch(() => [] as Array<{ event: string; pid: number; time: number }>);
    if (events.some((row) => row.event === event)) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const events = await f.events().catch(() => []);
  throw new Error(
    `Timed out waiting for driver event ${event}; saw ${events.map((row) => row.event).join(", ")}`,
  );
}
