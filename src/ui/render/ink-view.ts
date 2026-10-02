import { createElement as h, Fragment } from 'react';
import { render } from 'ink';

import { setLogSink } from '../../core/logger';

import { App } from './app';

const FRAME_MS = 80;

/** `renderExtra` returns whatever should sit below the transcript — e.g. the Prompt — and is re-evaluated every frame like the transcript itself. */
export function createInkView({ session, out, expandTools = false, showReasoning = false, onWrite, renderExtra }: any) {
  let instance: any = null;
  let timer: any = null;
  let frame = 0;
  let dirty = true;
  let paused = false;
  let stopped = false;
  let lastItemCount = 0;

  function element() {
    const state = session.state();
    if (state.items.length !== lastItemCount) {
      lastItemCount = state.items.length;
      onWrite?.();
    }
    const app = h(App, {
      state,
      frame,
      paused,
      expandTools: session.expandTools ?? expandTools,
      showReasoning: session.showReasoning ?? showReasoning,
      columns: out.columns || 80,
      rows: out.rows || 24,
    });
    // While a separate prompt owns the screen, the input box is not drawn: its last frame would stay in the
    // scrollback above that prompt, once per approval.
    const extra = paused ? null : renderExtra?.();
    return extra ? h(Fragment, null, app, extra) : app;
  }

  /** Take diagnostics off stderr for as long as this view is drawing. */
  function claimDiagnostics() {
    setLogSink((level, line) => {
      session.note(line, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'dim');
      dirty = true;
    });
  }

  function draw() {
    if (stopped || !instance) return;
    instance.rerender(element());
    dirty = false;
  }

  function tick() {
    if (stopped) return;
    const state = session.state();
    const animating = !paused && !state.done && Boolean(state.status || state.reasoning?.active || state.running.length);
    if (animating) frame += 1;
    if (dirty || animating) draw();
  }

  return {
    start() {
      if (instance || stopped) return;
      instance = render(element(), {
        stdout: out,
        patchConsole: false,
        exitOnCtrlC: false,
      });
      timer = setInterval(tick, FRAME_MS);
      timer.unref?.();
      claimDiagnostics(); // Ink owns the screen now, so a raw stderr write would land inside the frame it's about to redraw.
    },

    clear() {
      instance?.clear();
      dirty = true;
    },

    notify() {
      dirty = true;
    },

    flush() {
      if (!paused) draw();
    },

    pause() {
      if (paused || !instance) return;
      paused = true;
      setLogSink(null); // nothing draws while a separate approval prompt owns the screen, so stderr is safe again
      draw();
    },

    resume() {
      if (!paused) return;
      paused = false;
      dirty = true;
      claimDiagnostics();
      draw();
    },

    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (instance) {
        paused = true;
        stopped = false;
        draw();
        stopped = true;
        instance.unmount();
        instance = null;
        setLogSink(null);
      }
    },
  };
}

