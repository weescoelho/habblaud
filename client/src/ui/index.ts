// Interface do Habblaud (painéis DOM sobre o canvas do escritório).
// Recebe o OfficeStore (dados) e o WorldApi (canvas) e monta: barra superior com uso por conta,
// barra lateral, gaveta de detalhes, feed, avisos, configurações, ajuda e estados de carregamento/vazio.
// DOM incremental: os snapshots (até ~5/s) só marcam a UI como "suja"; tudo é reconciliado uma vez por quadro.
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import './styles.css';

import type { OfficeStore } from '../net/store';
import type { Selection, WorldApi } from '../world/api';
import { isDemoId } from '../../../shared/timeline';
import type { PanelName, UiComponent, UiContext } from './context';
import { DayLauncher } from './daystats-launcher';
import { RoomRenamer } from './roomrename';
import { h, iconButton, setText } from './dom';
import { Drawer } from './drawer';
import { FeedPanel } from './feed';
import { HelpDialog } from './help';
import { HistoryPopover } from './history';
import { HoverTip } from './hovertip';
import { hasRunningShells } from './model';
import { Mosaic } from './mosaic';
import { hasCodexPermission } from './provider';
import { Notifier } from './notify';
import { ConnectionBanner, EmptyState, Splash } from './overlays';
import { focusPermission, isLocalHostname, nextPermissionAgent } from './permission';
import { loadPrefs, safeLocalStorage, savePrefs, worldOptionsFrom, type UiPrefs } from './prefs';
import { SettingsPopover } from './settings';
import { Sidebar } from './sidebar';
import { SoundControl } from './sound';
import { createTask, emptyTaskForm, TASK_MODE_LABEL, TASK_MODES, type TaskForm, type TaskMode } from './tasks-model';
import { TERMINAL_UNAVAILABLE_HINT, TerminalPanel } from './terminal';
import { TimelapsePlayer } from './timelapse';
import { Toasts } from './toasts';
import { UpdateToaster } from './version';
import { TopBar } from './topbar';
import { UpdateBanner } from './update';
import { SkillsPanel } from './skills';
import { FreeArea } from './viewport';

/** Relógio dos tempos relativos ("há 5 s"). */
const CLOCK_MS = 5_000;
/** Relógio do cronômetro dos shells ("12:31") e do prazo dos pedidos do Codex, ligado só enquanto há um dos dois. */
const SHELL_CLOCK_MS = 1_000;
const NARROW_QUERY = '(max-width: 900px)';

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

export function createUI(root: HTMLElement, store: OfficeStore, world: WorldApi): void {
  const storage = safeLocalStorage();
  let prefs: UiPrefs = loadPrefs(storage);
  let selection: Selection = world.getSelection();
  let skew = 0;
  const narrowMq = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;
  const panels: Record<PanelName, boolean> = {
    sidebar: narrowMq?.matches ? false : prefs.sidebarOpen,
    feed: narrowMq?.matches ? false : prefs.feedOpen,
  };

  const live = h('div', { class: 'ui-sr', role: 'status', attrs: { 'aria-live': 'polite' } });

  let topbar: TopBar;
  let sidebar: Sidebar;
  let drawer: Drawer;
  let settings: SettingsPopover;
  let help: HelpDialog;
  let area: FreeArea;
  let timelapse: TimelapsePlayer;
  /** A seleção em curso partiu da UI (lista, feed, aviso...), não de um clique no canvas. */
  let uiSelecting = false;

  const ctx: UiContext = {
    store,
    world,
    root,
    get prefs() {
      return prefs;
    },
    updatePrefs(patch) {
      prefs = { ...prefs, ...patch };
      savePrefs(storage, prefs);
      world.setOptions(worldOptionsFrom(prefs));
      invalidate();
    },
    now: () => Date.now() + skew,
    account: (id) => store.snapshot?.accounts.find((a) => a.id === id),
    agent: (id) => store.agent(id),
    selection: () => selection,
    select(sel, opts) {
      if (sel && opts?.focus) area.setIntent(sel);
      else area.clearIntent();
      // A gaveta passa a contar na área livre ANTES do foco: o mundo centraliza já na parte visível.
      const prev = selection;
      selection = sel;
      area.selectingFromUi();
      applyLayout({ refocus: false });
      uiSelecting = true;
      try {
        world.select(sel, opts);
      } catch (err) {
        selection = prev;
        applyLayout();
        throw err;
      } finally {
        uiSelecting = false;
      }
    },
    focusSelection() {
      if (selection) ctx.select(selection, { focus: true });
    },
    camera(action) {
      area.clearIntent();
      if (action === 'overview') world.overview();
      else world.zoomBy(action === 'zoomIn' ? 1.25 : 1 / 1.25);
    },
    invalidate: () => invalidate(),
    togglePanel(name, open) {
      const next = open ?? !panels[name];
      if (panels[name] === next) return;
      panels[name] = next;
      if (!ctx.isNarrow()) ctx.updatePrefs(name === 'sidebar' ? { sidebarOpen: next } : { feedOpen: next });
      applyLayout();
      invalidate();
    },
    isPanelOpen: (name) => panels[name],
    isNarrow: () => !!narrowMq?.matches,
    announce(text) {
      live.textContent = '';
      requestAnimationFrame(() => (live.textContent = text));
    },
    focusSearch() {
      if (!panels.sidebar) ctx.togglePanel('sidebar', true);
      requestAnimationFrame(() => sidebar.focusSearch());
    },
    openHelp: (section) => help.open(section),
    toggleSettings: () => settings.toggle(topbar.settingsBtn),
    openAbout: () => settings.showAbout(topbar.settingsBtn),
    toggleTimelapse() {
      // O terminal mostra a conversa de agora: não combina com o dia reproduzido.
      if (!timelapse.isOpen && terminal.isOpen) terminal.close();
      timelapse.toggle();
    },
    isTimelapseOpen: () => timelapse.isOpen,
  };

  // ---------------------------------------------------------------- componentes
  const sound = new SoundControl(ctx);
  const notifier = new Notifier(ctx, sound.board);
  topbar = new TopBar(ctx);
  sidebar = new Sidebar(ctx);
  const terminal = new TerminalPanel(ctx);
  // Histórico de sessões (terminal): botão no grupo dos painéis da barra superior.
  const history = new HistoryPopover(ctx, terminal);
  topbar.panelGroup.prepend(history.button);
  drawer = new Drawer(ctx, terminal);
  // Mosaico de sessões: modo de layout (grid de cards) alternado pelo atalho V.
  const mosaic = new Mosaic(ctx, terminal);
  const feed = new FeedPanel(ctx);
  const toasts = new Toasts(ctx);
  const updateToaster = new UpdateToaster(ctx, (n) => toasts.push(n));
  settings = new SettingsPopover(ctx, notifier, sound);
  help = new HelpDialog();
  const day = new DayLauncher(ctx, (el) => root.append(el));
  topbar.addPanelButton(day.button);
  // "Nova tarefa" (P5 · SC-21): lança uma tarefa headless no projeto escolhido; a tarefa entra na sala como sessão comum.
  const tasks = new TaskLauncher(ctx);
  topbar.addPanelButton(tasks.button);
  // Painel de skills (P7 · SC-32/SC-33): lista e dispara skills na sessão-alvo.
  const skills = new SkillsPanel(ctx);
  topbar.addPanelButton(skills.button);
  // Botão direito numa sala (lista lateral ou escritório): renomear.
  const renamer = new RoomRenamer(ctx);
  ctx.renameRoom = (id, at) => renamer.open(id, at);
  world.onRoomContextMenu?.((id, at) => renamer.open(id, at));
  const empty = new EmptyState(ctx);
  const banner = new ConnectionBanner(ctx);
  const update = new UpdateBanner(store);
  const tip = new HoverTip(ctx);
  const splash = new Splash(ctx);
  timelapse = new TimelapsePlayer(ctx);
  const scrim = h('div', { class: 'ui-scrim', attrs: { 'aria-hidden': 'true' }, on: { click: () => ctx.togglePanel('sidebar', false) } });

  root.classList.add('ui-root');
  root.append(timelapse.vignette, topbar.el, sidebar.el, scrim, feed.el, drawer.el, terminal.el, mosaic.el, timelapse.el, timelapse.badge, toasts.el, banner.el, update.el, empty.el, tip.el, settings.el, history.el, help.el, tasks.el, skills.el, renamer.el, live, splash.el);
  area = new FreeArea(world, { root, topbar: topbar.el, sidebar: sidebar.el, drawer: drawer.el, feed: feed.el }, () => ({
    sidebar: panels.sidebar,
    feed: panels.feed,
    drawer: selection !== null && !drawer.floating,
    narrow: ctx.isNarrow(),
  }));
  drawer.onLayoutChange = () => applyLayout();

  const components: UiComponent[] = [topbar, sidebar, drawer, terminal, history, feed, toasts, settings, empty, banner, tip, notifier, splash, timelapse, mosaic, sound, day, tasks, skills, updateToaster];

  // ---------------------------------------------------------------- renderização agrupada por quadro
  let rafId = 0;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

  function renderAll(): void {
    rafId = 0;
    for (const c of components) {
      try {
        c.render();
      } catch (err) {
        console.error('[ui] falha ao renderizar', c.constructor.name, err);
      }
    }
  }

  function invalidate(): void {
    if (document.hidden) {
      // Com a aba oculta o navegador congela o rAF: mantém só título e alertas em dia.
      hiddenTimer ??= setTimeout(() => {
        hiddenTimer = null;
        notifier.render();
        toasts.render();
      }, 500);
      return;
    }
    if (!rafId) rafId = requestAnimationFrame(renderAll);
  }

  /** Aplica as classes de layout e informa ao mundo a área livre (sem esperar as transições dos painéis). */
  function applyLayout(opts: { refocus?: boolean } = {}): void {
    root.classList.toggle('has-sidebar', panels.sidebar);
    root.classList.toggle('has-feed', panels.feed);
    root.classList.toggle('has-drawer', selection !== null && !drawer.floating);
    root.classList.toggle('is-narrow', ctx.isNarrow());
    area.sync(opts);
  }

  // ---------------------------------------------------------------- eventos
  store.on('snapshot', (snap) => {
    // No timelapse o "agora" da interface é o instante reproduzido (serverTime do snapshot reconstruído).
    if (store.connection === 'open' || store.replaying) skew = snap.serverTime - Date.now();
    invalidate();
  });
  store.on('connection', () => invalidate());
  world.onSelect((sel) => {
    const prev = selection;
    selection = sel;
    // Clique no canvas (ou agente que saiu): a gaveta espera a janela do duplo clique antes de mexer na câmera.
    if (!uiSelecting) area.selectionChangedExternally(prev, sel);
    applyLayout(uiSelecting ? { refocus: false } : {});
    invalidate();
  });
  narrowMq?.addEventListener('change', (e) => {
    if (e.matches) {
      panels.sidebar = false;
      panels.feed = false;
    } else {
      panels.sidebar = prefs.sidebarOpen;
      panels.feed = prefs.feedOpen;
    }
    applyLayout();
    invalidate();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) invalidate();
  });
  setInterval(() => {
    if (!document.hidden) invalidate();
  }, CLOCK_MS);
  setInterval(() => {
    // Shells rodando (cronômetro) ou pedido do Codex esperando (prazo de segundos).
    if (!document.hidden && (hasRunningShells(store.snapshot) || hasCodexPermission(store.snapshot))) invalidate();
  }, SHELL_CLOCK_MS);

  addEventListener('keydown', (e) => onKey(e));

  function onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (help.isOpen || settings.isOpen || history.isOpen) return; // diálogo/popover tratam o próprio Esc
      // O mosaico cobre a tela: fecha primeiro.
      if (mosaic.isOpen) {
        mosaic.close();
        e.preventDefault();
        return;
      }
      // O terminal flutua sobre tudo: fecha primeiro (a busca dele, depois ele; a gaveta continua aberta).
      if (terminal.isOpen) {
        terminal.escape();
        e.preventDefault();
      } else if (ctx.isNarrow() && panels.sidebar) {
        ctx.togglePanel('sidebar', false);
        e.preventDefault();
      } else if (selection) {
        ctx.select(null);
        e.preventDefault();
      }
      return;
    }
    if (isTypingTarget(e.target) || help.isOpen) return;
    switch (e.key) {
      case '/':
        e.preventDefault();
        ctx.focusSearch();
        break;
      case '?':
        e.preventDefault();
        help.open();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        if (selection?.type === 'agent') drawer.toggleFollow();
        else ctx.announce('Selecione um agente para seguir.');
        break;
      case 't':
      case 'T':
        e.preventDefault();
        toggleTerminal();
        break;
      case 'l':
      case 'L':
        if (store.mock) break;
        e.preventDefault();
        ctx.toggleTimelapse();
        break;
      case 'p':
      case 'P': {
        // Próximo pedido de permissão ou pergunta para responder pelo escritório (só leva até ele: nunca aprova).
        e.preventDefault();
        const next = nextPermissionAgent(store.snapshot?.agents ?? [], selection?.type === 'agent' ? selection.id : undefined);
        if (next) focusPermission(ctx, next.id);
        else ctx.announce('Nenhum pedido de permissão ou pergunta para responder agora.');
        break;
      }
      case 'n':
      case 'N':
        // Nova tarefa headless (P5 · SC-21): abre o formulário do launcher.
        e.preventDefault();
        if (tasks.available()) tasks.toggle();
        else ctx.announce('As tarefas headless do Cursor não estão disponíveis.');
        break;
      case 'o':
      case 'O':
        e.preventDefault();
        ctx.camera('overview');
        break;
      case 'v':
      case 'V':
        // Mosaico de sessões (grid de cards) por cima do escritório.
        e.preventDefault();
        mosaic.toggle();
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        day.toggle();
        break;
      case '[':
        e.preventDefault();
        ctx.togglePanel('sidebar');
        break;
      case ']':
        e.preventDefault();
        ctx.togglePanel('feed');
        break;
    }
  }

  /** Atalho T: abre o terminal do agente selecionado (ou fecha o que estiver aberto). */
  function toggleTerminal(): void {
    const id = selection?.type === 'agent' ? selection.id : null;
    if (terminal.isOpen && (id === null || terminal.agentId === id)) terminal.close();
    else if (id === null) ctx.announce('Selecione um agente para abrir o terminal.');
    else if (!store.snapshot?.meta.terminal) ctx.announce(`${TERMINAL_UNAVAILABLE_HINT}.`);
    else if (!ctx.agent(id)) ctx.announce('O agente já saiu do escritório.');
    else terminal.open(id);
  }

  // ---------------------------------------------------------------- início
  world.setOptions(worldOptionsFrom(prefs));
  applyLayout();
  renderAll();
}

/** Ícone "Nova tarefa" (o mesmo traço pixel dos outros botões; um "+"). */
const TASK_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M4 0h2v4h4v2H6v4H4V6H0V4h4z"/></svg>';

/**
 * "Nova tarefa" (P5 · SC-21): lança uma tarefa headless do Cursor no projeto escolhido. A tarefa passa a aparecer na
 * sala do projeto como uma sessão comum (observável pelo Office). Só fica disponível com o recurso ligado
 * (snapshot.meta.tasks) e o acesso local — a mesma trava do terminal.
 */
class TaskLauncher implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLDialogElement;
  private readonly project: HTMLSelectElement;
  private readonly promptInput: HTMLTextAreaElement;
  private readonly mode: HTMLSelectElement;
  private readonly model: HTMLInputElement;
  private readonly isolated: HTMLInputElement;
  private readonly hint: HTMLParagraphElement;
  private readonly submit: HTMLButtonElement;
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.button = iconButton(TASK_ICON, 'Nova tarefa (N)', () => this.toggle());

    this.project = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': 'Projeto de origem' } });
    this.promptInput = h('textarea', {
      class: 'ui-rename__input',
      attrs: { rows: 3, placeholder: 'O que o agente deve fazer?', 'aria-label': 'Descrição da tarefa' },
    });
    this.mode = h(
      'select',
      { class: 'ui-rename__input', attrs: { 'aria-label': 'Modo' } },
      ...TASK_MODES.map((m) => h('option', { text: TASK_MODE_LABEL[m], attrs: { value: m } })),
    );
    this.mode.value = 'plan';
    this.model = h('input', { class: 'ui-rename__input', type: 'text', attrs: { placeholder: 'auto', 'aria-label': 'Modelo', spellcheck: 'false' } });
    this.isolated = h('input', { type: 'checkbox', attrs: { 'aria-label': 'Isolar em worktree' } });
    this.isolated.checked = true;
    this.hint = h('p', { class: 'ui-rename__hint' });
    this.submit = h('button', { class: 'ui-btn ui-btn--primary', type: 'submit', text: 'Criar tarefa' });

    const form = h(
      'form',
      {
        class: 'ui-dialog__body',
        style: 'grid-template-columns:1fr; gap:10px; align-content:start',
        on: {
          submit: (e) => {
            e.preventDefault();
            void this.create();
          },
        },
      },
      h('label', { text: 'Projeto' }),
      this.project,
      h('label', { text: 'Descrição' }),
      this.promptInput,
      h('label', { text: 'Modo' }),
      this.mode,
      h('label', { text: 'Modelo' }),
      this.model,
      h('label', {}, this.isolated, h('span', { text: ' Isolar em worktree (branch própria)' })),
      this.hint,
      this.submit,
    );
    this.el = h(
      'dialog',
      { class: 'ui-dialog', style: 'width:min(420px, calc(100vw - 32px))', attrs: { 'aria-label': 'Nova tarefa' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: 'Nova tarefa' })),
      form,
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
  }

  /** O recurso está ligado e acessível por este computador? */
  available(): boolean {
    return !!this.ctx.store.snapshot?.meta.tasks && !this.ctx.store.mock && !this.ctx.store.replaying && isLocalHostname(location.hostname);
  }

  toggle(): void {
    if (this.el.open) this.el.close();
    else {
      this.syncProjects();
      setText(this.hint, '');
      this.hint.classList.remove('is-error');
      this.el.showModal();
      this.promptInput.focus();
    }
  }

  render(): void {
    this.button.hidden = !this.available();
    if (this.el.open && !this.available()) this.el.close();
  }

  /** Projetos reais (sem as salas de demonstração), preservando a escolha. */
  private syncProjects(): void {
    const rooms = (this.ctx.store.snapshot?.rooms ?? []).filter((r) => !isDemoId(r.id));
    const previous = this.project.value;
    this.project.replaceChildren(...rooms.map((r) => h('option', { text: r.name, attrs: { value: r.id } })));
    if (rooms.some((r) => r.id === previous)) this.project.value = previous;
  }

  private async create(): Promise<void> {
    if (this.busy) return;
    const sel = this.ctx.selection();
    const cwd = this.project.value || (sel?.type === 'room' ? sel.id : '');
    const form: TaskForm = {
      ...emptyTaskForm(cwd),
      prompt: this.promptInput.value,
      mode: this.mode.value as TaskMode,
      model: this.model.value,
      isolated: this.isolated.checked,
    };
    this.busy = true;
    this.submit.disabled = true;
    try {
      const res = await createTask(form);
      if ('error' in res) {
        setText(this.hint, `Não deu: ${res.error}`);
        this.hint.classList.add('is-error');
        return;
      }
      this.el.close();
      this.promptInput.value = '';
      this.ctx.announce(`Tarefa “${res.task.label}” criada na sala do projeto.`);
    } finally {
      this.busy = false;
      this.submit.disabled = false;
    }
  }
}
