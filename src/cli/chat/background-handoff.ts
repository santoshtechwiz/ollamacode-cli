// A background process the agent started is the agent's to follow up on. When it ends, the person sees the result and
// the agent is handed it without anyone typing: a running turn sees it in its next request, an idle chat starts a turn
// for it, and one that ended after the turn's last request is handed over as soon as that turn ends.

import { describeExitForPerson, exitHeadline, type BackgroundInbox } from '../../tool/process/background-inbox';

/** Turns started by background results in a row before ocode waits for the person again. */
export const MAX_AUTO_HANDOFFS = 3;

export interface HandoffHost {
  background: BackgroundInbox | null | undefined;
  /** A turn is running. */
  busy: () => boolean;
  /** Input the person queued behind a running turn: theirs goes first. */
  queued: () => boolean;
  /** The person is typing: the message they send carries the result anyway. */
  typing: () => boolean;
  /** The last turn was stopped or failed: what it left is not picked up again on its own. */
  lastTurnUnfinished: () => boolean;
  note: (text: string, tone: 'success' | 'warn' | 'dim') => void;
  /** Show the turn's input in the transcript, marked as sent on the person's behalf. */
  echo: (text: string) => void;
  runTurn: (text: string) => Promise<void>;
  /** Run once a hand-off turn ends, for input queued meanwhile. */
  afterTurn: () => Promise<void>;
}

export interface BackgroundHandoff {
  /** The person typed: background results may be handed to the agent again. */
  personSpoke: () => void;
  /** A turn or command ended: hand over what ended in the background meanwhile. */
  handOff: () => Promise<void>;
  stop: () => void;
}

export function createBackgroundHandoff(host: HandoffHost): BackgroundHandoff {
  let handoffs = 0;
  let scheduled = false;
  const canHandOff = () => !host.lastTurnUnfinished() && handoffs < MAX_AUTO_HANDOFFS && !host.typing();

  const handOff = async (): Promise<void> => {
    const exits = host.background?.pending() ?? [];
    if (!exits.length || host.busy() || host.queued() || !canHandOff()) return;
    handoffs += 1;
    const text = exits.map(exitHeadline).join('; ');
    host.echo(text);
    await host.runTurn(text);
    await host.afterTurn();
  };

  // Exits that land together (a build and its tests) go to the agent in one turn.
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      void handOff();
    }, 0);
  };

  const unsubscribeStart = host.background?.onStart((job) =>
    host.note(`"${job.id}" keeps running in the background — when it ends I'll show the result here and pass it to the agent, no need to type anything`, 'dim'),
  );
  const unsubscribeExit = host.background?.subscribe((exit) => {
    const followUp = !canHandOff()
      ? 'the agent will see it with your next message'
      : host.busy() ? 'the agent gets it with this turn' : 'passing it to the agent now';
    host.note(describeExitForPerson(exit, followUp), exit.outcome === 'finished' ? 'success' : 'warn');
    if (!host.busy()) schedule();
  });

  return {
    personSpoke: () => {
      handoffs = 0;
    },
    handOff,
    stop: () => {
      unsubscribeStart?.();
      unsubscribeExit?.();
    },
  };
}
