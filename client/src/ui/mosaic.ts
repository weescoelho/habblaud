// Mosaico de sessões (P4): um grid com um card por agente ao vivo (provedor, status, atividade atual e último
// diff). O clique abre o terminal do agente; quem espera o usuário vem no topo — a ordenação é do modelo
// (ui/mosaic-model.ts, testado lá) — e ganha destaque e badge. O aviso do sistema continua sendo do Notifier.
import type { UiComponent, UiContext } from './context';
import { h, iconButton, KeyedList, setAttr, setHidden, setText, setTitle } from './dom';
import { shortPath } from './format';
import { ICONS } from './icons';
import { computeCounters, statusLabel } from './model';
import { mosaicCards, type MosaicCard } from './mosaic-model';
import { PROVIDER_NAME } from './provider';
import type { TerminalControl } from './terminal';
import { createActivityLine, createStatusDot, updateActivityLine, updateStatusDot } from './widgets';

/** Partes de um card, guardadas por elemento (como nos shells da gaveta). */
interface CardRefs {
  name: HTMLElement;
  prov: HTMLElement;
  dot: HTMLElement;
  status: HTMLElement;
  room: HTMLElement;
  activity: HTMLElement;
  diff: HTMLElement;
  diffFile: HTMLElement;
  diffAdd: HTMLElement;
  diffDel: HTMLElement;
  agentId: string;
}

const cardRefs = new WeakMap<HTMLElement, CardRefs>();

function createCard(terminal: TerminalControl): HTMLElement {
  const dot = createStatusDot();
  const name = h('strong', { class: 'ui-mosaic__name' });
  const prov = h('span', { class: 'ui-mosaic__prov' });
  const status = h('span', { class: 'ui-mosaic__status' });
  const room = h('span', { class: 'ui-mosaic__room' });
  const activity = createActivityLine();
  const diffFile = h('span', { class: 'ui-mosaic__diff-file' });
  const diffAdd = h('span', { class: 'ui-plus' });
  const diffDel = h('span', { class: 'ui-minus' });
  const diff = h('div', { class: 'ui-mosaic__diff', hidden: true }, diffFile, diffAdd, diffDel);
  const card = h(
    'button',
    { class: 'ui-panel ui-mosaic__card', type: 'button', style: 'text-align:left; cursor:pointer; padding:10px' },
    h('div', { class: 'ui-mosaic__head', style: 'display:flex; align-items:center; gap:8px' }, dot, name, prov),
    h('div', { class: 'ui-mosaic__meta', style: 'display:flex; align-items:center; gap:8px' }, status, room),
    activity,
    diff,
  );
  cardRefs.set(card, { name, prov, dot, status, room, activity, diff, diffFile, diffAdd, diffDel, agentId: '' });
  // SC-18: o clique abre o terminal do agente (o próprio card é o "opener" do painel).
  card.addEventListener('click', () => {
    const id = cardRefs.get(card)!.agentId;
    if (id) terminal.open(id, card);
  });
  return card;
}

function updateCard(card: HTMLElement, c: MosaicCard, ctx: UiContext): void {
  const r = cardRefs.get(card)!;
  r.agentId = c.agentId;
  const agent = ctx.agent(c.agentId);
  const room = ctx.store.room(c.roomId);
  setText(r.name, agent?.name ?? 'Agente');
  setText(r.prov, PROVIDER_NAME[c.provider]);
  updateStatusDot(r.dot, c.status);
  setText(r.status, statusLabel(c.status));
  setText(r.room, room?.name ?? c.roomId);
  updateActivityLine(r.activity, c.activity);
  if (c.diff) {
    setHidden(r.diff, false);
    setText(r.diffFile, shortPath(c.diff.file));
    setText(r.diffAdd, `+${c.diff.added}`);
    setText(r.diffDel, `−${c.diff.removed}`);
    setTitle(r.diff, c.diff.file);
  } else {
    setHidden(r.diff, true);
  }
  card.classList.toggle('is-waiting', c.status === 'waiting');
  setAttr(card, 'aria-label', `${agent?.name ?? 'Agente'}: ${statusLabel(c.status)}. Abrir o terminal.`);
}

/**
 * Modo de layout (UiComponent): mostra o grid de cards; a alternância/atalho fica no shell (`ui/index.ts`).
 * O estilo é mínimo e inline para manter a tarefa dentro deste arquivo.
 */
export class Mosaic implements UiComponent {
  readonly el: HTMLElement;
  private badge: HTMLElement;
  private empty: HTMLElement;
  private grid: HTMLElement;
  private cards: KeyedList<MosaicCard>;
  private showing = false;

  constructor(
    private ctx: UiContext,
    private terminal: TerminalControl,
  ) {
    this.badge = h('span', { class: 'ui-mosaic__badge ui-alert__title', hidden: true });
    const bar = h(
      'div',
      { class: 'ui-mosaic__bar', style: 'display:flex; align-items:center; gap:8px' },
      h('strong', { class: 'ui-mosaic__title', text: 'Mosaico de sessões' }),
      this.badge,
      h('span', { style: 'flex:1' }),
      iconButton(ICONS.close, 'Fechar mosaico (Esc)', () => this.close()),
    );
    this.empty = h('p', { class: 'ui-muted', text: 'Nenhum agente ao vivo agora.' });
    this.grid = h('div', { class: 'ui-mosaic__grid', style: 'display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; margin-top:12px' });
    this.cards = new KeyedList<MosaicCard>(this.grid, { key: (c) => c.agentId, create: () => createCard(this.terminal), update: (el, c) => updateCard(el, c, this.ctx) });
    this.el = h(
      'aside',
      { class: 'ui-panel ui-mosaic', hidden: true, attrs: { 'aria-label': 'Mosaico de sessões' }, style: 'position:fixed; inset:0; z-index:55; overflow:auto; padding:16px' },
      bar,
      this.empty,
      this.grid,
    );
  }

  get isOpen(): boolean {
    return this.showing;
  }

  open(): void {
    if (this.showing) return;
    this.showing = true;
    setHidden(this.el, false);
    this.render();
  }

  close(): void {
    if (!this.showing) return;
    this.showing = false;
    setHidden(this.el, true);
  }

  toggle(): void {
    if (this.showing) this.close();
    else this.open();
  }

  render(): void {
    if (!this.showing) return;
    const cards = mosaicCards(this.ctx.store.snapshot);
    setHidden(this.empty, cards.length > 0);
    // SC-19: badge de quem espera (mesma fonte do título da aba em ui/notify.ts); a notificação do sistema é do Notifier.
    const waiting = computeCounters(this.ctx.store.liveSnapshot).waiting;
    setHidden(this.badge, waiting === 0);
    setText(this.badge, waiting === 1 ? '1 precisa de você' : `${waiting} precisam de você`);
    // SC-20: o modelo já ordena `waiting` no topo; o grid rola sem escondê-los.
    this.cards.sync(cards);
  }
}
