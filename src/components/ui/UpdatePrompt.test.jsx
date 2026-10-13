import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import UpdatePrompt, { QUEUE_ON_DISK_MS, WRITES_WAIT_MS } from './UpdatePrompt';
import { createAppUpdater } from '../../lib/appUpdate';
import { FIELD_LEFT_MS } from '../../lib/fieldWatch';
import { SKIP_WAITING } from '../../lib/swHandlers';
import { startRestTimer, resetRestTimer } from '../../hooks/useRestTimer';
import { fakeBrowser, memoryStorage } from '../../test/fakeServiceWorker';

// The real updater over a fake browser, the real rest timer, a real React
// Query client: what is replaced is the service worker and the reload.

const READY = 'A new version of the app is ready.';
const UPDATING = 'Updating…';
const STILL_SAVING = 'A change is still being saved. Try again in a moment.';
const TOLD = { type: SKIP_WAITING };

let visibility;
let world;
let updater;
let reload;
let queryClient;

function setVisibility(value) {
  visibility = value;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

/** A write that stays on its way until `finish()`. */
async function startWrite() {
  let finish;
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationFn: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  mutation.execute().catch(() => {});
  await flush();
  return { finish: () => finish('saved') };
}

async function mount(children = null) {
  await updater.start({ swUrl: '/sl_app/sw.js', scope: '/sl_app/' });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/student']}>
        {children}
        <Link to="/student/stats">Stats</Link>
        <UpdatePrompt updater={updater} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A new version arrives: found, installed, waiting. */
function newVersion() {
  let worker;
  act(() => {
    worker = world.waitingWorker();
  });
  return worker;
}

/** The focus leaves `field`, and the moment a tap needs to end has passed. */
async function leave(field) {
  await act(async () => {
    field.blur();
  });
  act(() => {
    vi.advanceTimersByTime(FIELD_LEFT_MS);
  });
}

/** A keystroke, as the browser reports it. */
const type = (field, value) => fireEvent.input(field, { target: { value } });

/** A draft that lives in the state of its component, like the app's composers. */
function Composer() {
  const [draft, setDraft] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setDraft('');
      }}
    >
      <textarea aria-label="message" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="submit">Send</button>
    </form>
  );
}

/** A form that goes away when it is sent, like the exercise form. */
function ExerciseForm({ onCreate }) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('');
  if (!open) return null;
  return (
    <div>
      <input aria-label="name" value={name} onChange={(event) => setName(event.target.value)} />
      <button
        type="button"
        onClick={() => {
          onCreate(name);
          setOpen(false);
        }}
      >
        Create
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T08:00:00Z'));
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  world = fakeBrowser();
  reload = vi.fn();
  updater = createAppUpdater({
    container: world.container,
    reload,
    storage: memoryStorage(),
    buildId: 'build-1',
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  updater.stop();
  act(() => resetRestTimer());
  onlineManager.setOnline(true);
  queryClient.clear();
  delete document.visibilityState;
  vi.useRealTimers();
});

describe('<UpdatePrompt /> — nothing to say', () => {
  it('renders nothing while no new version waits', async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-testid="update-prompt"]')).toBeNull();
  });
});

describe('<UpdatePrompt /> — a safe moment', () => {
  it('applies the update without a tap, and reloads once the worker has taken over', async () => {
    await mount();
    const worker = newVersion();

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING);
    expect(screen.queryByRole('button')).toBeNull();
    expect(reload).not.toHaveBeenCalled();

    // The worker has the page and is not activated yet — a second, in
    // Chromium. The page is still the old one, and it says what is going on.
    act(() => world.activating(worker));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING);

    act(() => world.activated(worker));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING); // until the page is replaced
  });

  it('applies an update that was already waiting when the shell mounts', async () => {
    const worker = world.waitingWorker();
    await mount();
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('does not reload over a rest that began while the worker was taking over', async () => {
    await mount();
    const worker = newVersion(); // nothing going on: applied without a tap
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING);

    // The set is ticked while the worker, which has the page already, is on
    // its way to `activated`.
    act(() => world.activating(worker));
    expect(reload).not.toHaveBeenCalled();
    act(() => startRestTimer('log-1', 120));
    act(() => world.activated(worker));

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(READY);
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();

    // The rest is over and the app comes back to the front: now.
    act(() => {
      vi.advanceTimersByTime(121 * 1000);
    });
    expect(reload).not.toHaveBeenCalled();
    setVisibility('hidden');
    setVisibility('visible');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a button or a checkbox with the focus is not something being typed', async () => {
    await mount(<input type="checkbox" aria-label="done" />);
    act(() => screen.getByLabelText('done').focus());
    const worker = newVersion();
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('a field that was used and is empty again is not either', async () => {
    await mount(<Composer />);
    const field = screen.getByLabelText('message');
    act(() => field.focus());
    type(field, 'on my way');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(field).toHaveValue('');
    await leave(field);

    const worker = newVersion();
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('does not reload over a message begun while the worker was taking over', async () => {
    await mount(<Composer />);
    const worker = newVersion();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    act(() => world.activating(worker));
    type(screen.getByLabelText('message'), 'B');
    act(() => world.activated(worker));

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(READY);
  });
});

describe('<UpdatePrompt /> — what a reload would lose', () => {
  it('a write on its way: not applied, offered', async () => {
    await mount();
    await startWrite();
    const worker = newVersion();

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(READY);
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a write queued offline: not applied, offered', async () => {
    onlineManager.setOnline(false);
    await mount();
    await startWrite();
    expect(queryClient.isMutating({ predicate: (m) => m.state.isPaused })).toBe(1);

    const worker = newVersion();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(READY);
  });

  it('a rest timer running: not applied, offered, and the offer says what "Update" costs', async () => {
    await mount();
    act(() => startRestTimer('log-1', 120));
    const worker = newVersion();

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(READY);
    expect(screen.getByText('Updating now stops the rest timer.')).toBeInTheDocument();

    // The rest ends. That is not a moment to reload — the next set is about to
    // be ticked — but the warning has nothing left to warn about.
    act(() => {
      vi.advanceTimersByTime(121 * 1000);
    });
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.queryByText('Updating now stops the rest timer.')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(READY);

    // Coming back to the app is one.
    setVisibility('hidden');
    setVisibility('visible');
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('a field with the focus: not applied, and the offer stays out of the way until the field is left', async () => {
    await mount(<textarea aria-label="feedback" />);
    const field = screen.getByLabelText('feedback');
    act(() => field.focus());

    const worker = newVersion();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();

    await leave(field);
    expect(screen.getByRole('status')).toHaveTextContent(READY);
    expect(worker.postMessage).not.toHaveBeenCalled(); // leaving a field is not a moment either
  });

  it('the tap that takes the focus out of a field lands where it was aimed: the offer comes after it', async () => {
    // A phone with the keyboard open: the form's button sits where the card
    // goes. The press moves the focus; a card drawn then is under the finger
    // when it lifts, and the button gets no click.
    const onCreate = vi.fn();
    await mount(<ExerciseForm onCreate={onCreate} />);
    const field = screen.getByLabelText('name');
    const create = screen.getByRole('button', { name: 'Create' });
    act(() => field.focus());
    type(field, 'Pull-up');
    newVersion();
    expect(screen.queryByRole('status')).toBeNull(); // offered, and out of the way

    // One tap, as the browser sends it.
    fireEvent.pointerDown(create);
    fireEvent.mouseDown(create);
    await act(async () => {
      create.focus(); // what the press does: the field loses the focus here
    });
    expect(screen.queryByRole('status')).toBeNull(); // nothing new under the finger
    fireEvent.pointerUp(create);
    fireEvent.mouseUp(create);
    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledWith('Pull-up');

    act(() => {
      vi.advanceTimersByTime(FIELD_LEFT_MS - 1);
    });
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent(READY);
  });

  it('text that was typed and not sent: not applied, with or without the focus, at any later moment', async () => {
    await mount(<Composer />);
    const field = screen.getByLabelText('message');
    act(() => field.focus());
    type(field, 'Bien joué sur les tractions, la');
    await leave(field); // a look at the session above, the draft stays where it is

    // The hourly question finds a new version.
    const worker = newVersion();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(READY);

    // "Later", and the app comes back to the foreground: nothing is reloaded.
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    setVisibility('hidden');
    setVisibility('visible');
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(field).toHaveValue('Bien joué sur les tractions, la');
    expect(screen.getByRole('status')).toHaveTextContent(READY);

    // Another page of the same shell, the composer still mounted: the same.
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    fireEvent.click(screen.getByRole('link', { name: 'Stats' }));
    expect(worker.postMessage).not.toHaveBeenCalled();

    // Sent: the next return to the app applies it.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    setVisibility('hidden');
    setVisibility('visible');
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('a form that was filled in and is gone holds nothing back', async () => {
    const onCreate = vi.fn();
    await mount(<ExerciseForm onCreate={onCreate} />);
    const field = screen.getByLabelText('name');
    act(() => field.focus());
    type(field, 'Pull-up');
    await leave(field);

    const worker = newVersion();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(READY);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.queryByLabelText('name')).toBeNull();
    setVisibility('hidden');
    setVisibility('visible');
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('an open dialog: not applied, offered', async () => {
    await mount(<dialog open aria-label="copy to" />);
    const worker = newVersion();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(READY);
  });

  it('a window nobody looks at: nothing, until it is looked at', async () => {
    await mount();
    setVisibility('hidden');
    const worker = newVersion();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();

    setVisibility('visible');
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });
});

describe('<UpdatePrompt /> — the offer', () => {
  it('"Update" applies it although a rest timer runs', async () => {
    await mount();
    act(() => startRestTimer('log-1', 120));
    const worker = newVersion();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();

    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING);
    act(() => world.activating(worker));
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING);
    expect(screen.queryByRole('button')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    act(() => world.activated(worker));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('"Update" applies it although a message is written and not sent', async () => {
    await mount(<Composer />);
    const field = screen.getByLabelText('message');
    type(field, 'a draft the person decides to let go');
    const worker = newVersion();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
    act(() => world.takeOver(worker));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('gives the sentence the width of the card: the two actions are in a row of their own, below it', async () => {
    // Side by side with "Mettre à jour" or "Aktualisieren", the sentence is a
    // column of two words on a phone and the card covers a third of the page.
    await mount();
    act(() => startRestTimer('log-1', 120));
    newVersion();

    const card = screen.getByRole('status');
    const later = screen.getByRole('button', { name: 'Later' });
    const update = screen.getByRole('button', { name: 'Update' });
    const actions = update.parentElement;

    expect(later.parentElement).toBe(actions);
    expect(actions.parentElement).toBe(card);
    expect(actions).not.toHaveTextContent(READY);
    expect([...card.children].map((el) => el.tagName)).toEqual(['P', 'P', 'DIV']); // offer, what it costs, actions
    expect(card.lastElementChild).toBe(actions);
    expect(card.className).not.toMatch(/\bflex\b/);
    // Thumb-sized, both.
    expect(later.className).toContain('min-h-[44px]');
    expect(update.className).toContain('min-h-[44px]');
  });

  it('"Update" waits for a write that is on its way', async () => {
    await mount();
    const write = await startWrite();
    const worker = newVersion();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING);
    expect(worker.postMessage).not.toHaveBeenCalled();

    write.finish();
    await flush();
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('"Update" gives the offer back when the write does not come back, and reloads nothing', async () => {
    await mount();
    const write = await startWrite(); // a request the network neither answers nor fails
    const worker = newVersion();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(WRITES_WAIT_MS - 1);
    });
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING);
    expect(screen.queryByRole('button')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent(STILL_SAVING);
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    // The write arrives after all, long after the wait was given up: nothing
    // happens behind the person's back.
    write.finish();
    await flush();
    expect(worker.postMessage).not.toHaveBeenCalled();

    // The second tap goes through.
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('"Later" after a write that did not come back: the next offer is the plain one', async () => {
    await mount();
    await startWrite();
    newVersion();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(WRITES_WAIT_MS);
    });
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent(STILL_SAVING);

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Stats' }));
    expect(screen.getByRole('status')).toHaveTextContent(READY);
  });

  it('"Update" gives a queued write the time to reach the disk', async () => {
    onlineManager.setOnline(false);
    await mount();
    await startWrite();
    const worker = newVersion();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();
    expect(worker.postMessage).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(QUEUE_ON_DISK_MS);
    });
    await flush();
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('"Later" takes the offer away; the next page brings it back, or applies it', async () => {
    await mount();
    act(() => startRestTimer('log-1', 120));
    const worker = newVersion();

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status')).toBeNull();

    // Another page, the rest still running: offered again.
    fireEvent.click(screen.getByRole('link', { name: 'Stats' }));
    expect(screen.getByRole('status')).toHaveTextContent(READY);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('a change of page with nothing going on applies it', async () => {
    await mount();
    act(() => startRestTimer('log-1', 60));
    const worker = newVersion();
    act(() => {
      vi.advanceTimersByTime(61 * 1000);
    });
    expect(worker.postMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('link', { name: 'Stats' }));
    expect(worker.postMessage).toHaveBeenCalledWith(TOLD);
  });

  it('says so when the worker did not take over, and offers again', async () => {
    await mount();
    const worker = newVersion(); // applied on its own…
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(10 * 1000); // …and nothing happened
    });
    expect(screen.getByRole('status')).toHaveTextContent('The update did not start.');
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it('a page whose worker changed under it (another window updated) is offered the reload, not reloaded', async () => {
    await mount(<textarea aria-label="feedback" />);
    const field = screen.getByLabelText('feedback');
    act(() => field.focus());
    const worker = newVersion();

    act(() => world.takeOver(worker)); // the other window was ready first
    expect(reload).not.toHaveBeenCalled();

    await leave(field);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a page whose worker changes under it at a safe moment says "Updating…" until that worker is activated', async () => {
    await mount();
    act(() => startRestTimer('log-1', 60));
    const worker = newVersion(); // offered: a rest is running
    act(() => {
      vi.advanceTimersByTime(61 * 1000);
    });
    expect(worker.postMessage).not.toHaveBeenCalled();

    act(() => world.activating(worker)); // the other window applies it
    expect(screen.getByRole('status')).toHaveTextContent(UPDATING);
    expect(reload).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();

    act(() => world.activated(worker));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stops answering when the shell unmounts', async () => {
    const view = await mount();
    view.unmount();
    const worker = world.waitingWorker();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(updater.getState()).toMatchObject({ pending: true, offered: false });
  });
});
