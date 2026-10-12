// Painel de skills (P7 · SC-32/SC-33): lista as skills do catálogo e dispara a escolhida na sessão-alvo.
// Só fica disponível com o recurso ligado (snapshot.meta.messages ligado implica skills ligadas, mesma trava
// local do terminal) e acesso local — o servidor barra o resto.
import { h, iconButton, setText } from './dom';
import type { SkillInfo } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { skillsView, sourceLabel, UNAVAILABLE_SKILL_ERROR, NOT_FOUND_SKILL_ERROR } from './skills-model';
import { isLocalHostname } from './permission';

/** Ícone "Skills" (engrenagem pixel). */
const SKILLS_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M5 0v10M0 5h10M2 2l6 6M8 2L2 8"/></svg>';

/**
 * Painel de skills: abre na lateral (como a ajuda/configurações) e mostra a lista de skills do projeto
 * da sessão selecionada (ou do projeto padrão). Clicar numa skill faz POST /api/skills/run {agentId, skill}.
 */
export class SkillsPanel implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLDialogElement;
  private readonly list: HTMLUListElement;
  private readonly hint: HTMLParagraphElement;
  private readonly refresh: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private currentAgentId: string | null = null;
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.button = iconButton(SKILLS_ICON, 'Skills (K)', () => this.toggle());

    this.list = h('ul', { class: 'ui-skills__list' });
    this.hint = h('p', { class: 'ui-skills__hint' });
    this.refresh = h('button', { class: 'ui-btn', type: 'button', text: 'Atualizar', on: { click: () => this.load() } });
    this.closeBtn = h('button', { class: 'ui-btn', type: 'button', text: 'Fechar', on: { click: () => this.el.close() } });

    const body = h(
      'div',
      { class: 'ui-dialog__body', style: 'display:grid; grid-template-rows:auto 1fr auto; gap:10px; min-height:240px' },
      h('div', { style: 'display:flex; gap:8px; justify-content:space-between; align-items:center' },
        h('h3', { text: 'Skills disponíveis' }),
        this.refresh,
      ),
      h('div', { style: 'overflow:auto' }, this.list),
      h('div', { style: 'display:flex; gap:8px; justify-content:flex-end; border-top:1px solid var(--ui-border); padding-top:8px' },
        this.hint,
        this.closeBtn,
      ),
    );

    this.el = h(
      'dialog',
      { class: 'ui-dialog', style: 'width:min(380px, calc(100vw - 32px))', attrs: { 'aria-label': 'Painel de skills' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: 'Skills' })),
      body,
    );

    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
  }

  /** O recurso está ligado e acessível por este computador? */
  available(): boolean {
    // Skills usam a mesma trava do terminal (bind local) e precisam de mensagens ligadas (canMessage).
    const snap = this.ctx.store.snapshot;
    return !!snap?.meta.messages && !this.ctx.store.mock && !this.ctx.store.replaying && isLocalHostname(location.hostname);
  }

  toggle(): void {
    if (this.el.open) {
      this.el.close();
    } else {
      this.syncAgent();
      this.load();
      this.el.showModal();
    }
  }

  /** Sincroniza o agente alvo com a seleção atual. */
  private syncAgent(): void {
    const sel = this.ctx.selection();
    if (sel?.type === 'agent') {
      this.currentAgentId = sel.id;
    }
  }

  /** Carrega o catálogo do projeto do agente atual (ou do projeto padrão). */
  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refresh.disabled = true;
    setText(this.hint, '');
    this.hint.classList.remove('is-error');
    this.list.replaceChildren(h('li', { class: 'ui-skills__loading', text: 'Carregando…' }));

    try {
      const params = new URLSearchParams();
      if (this.currentAgentId) params.set('agentId', this.currentAgentId);
      const res = await fetch(`/api/skills?${params.toString()}`);
      if (!res.ok) throw new Error(`erro ${res.status}`);
      const body = (await res.json()) as { skills: SkillInfo[] };
      this.renderList(body.skills);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar skills';
      setText(this.hint, `Não deu: ${msg}`);
      this.hint.classList.add('is-error');
      this.list.replaceChildren();
    } finally {
      this.busy = false;
      this.refresh.disabled = false;
    }
  }

  /** Renderiza a lista de skills. */
  private renderList(skills: SkillInfo[]): void {
    const view = skillsView(skills);
    if (!view.length) {
      this.list.replaceChildren(h('li', { class: 'ui-skills__empty', text: 'Nenhuma skill encontrada nos diretórios conhecidos' }));
      return;
    }
    this.list.replaceChildren(
      ...view.map((s) =>
        h(
          'li',
          {
            class: `ui-skills__item${s.available ? '' : ' is-unavailable'}`,
            attrs: { 'data-skill': s.name },
            on: {
              click: () => this.runSkill(s),
            },
          },
          h('div', { class: 'ui-skills__name' }, h('strong', { text: s.name }), s.available ? null : h('span', { class: 'ui-skills__badge', text: 'indisponível' })),
          s.description ? h('p', { class: 'ui-skills__desc', text: s.description }) : null,
          h('span', { class: 'ui-skills__source', text: sourceLabel(s.source) }),
        ),
      ),
    );
  }

  /** Dispara a skill na sessão-alvo (POST /api/skills/run). */
  private async runSkill(skill: { name: string; available: boolean }): Promise<void> {
    if (!skill.available) {
      setText(this.hint, UNAVAILABLE_SKILL_ERROR);
      this.hint.classList.add('is-error');
      return;
    }
    if (!this.currentAgentId) {
      setText(this.hint, 'Selecione um agente para usar a skill');
      this.hint.classList.add('is-error');
      return;
    }
    if (this.busy) return;
    this.busy = true;
    setText(this.hint, '');
    this.hint.classList.remove('is-error');

    try {
      const res = await fetch('/api/skills/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: this.currentAgentId, skill: skill.name }),
      });
      if (res.status === 200) {
        this.ctx.announce(`Skill "${skill.name}" disparada na sessão.`);
        this.el.close();
        return;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        // sem JSON
      }
      const error = (body as { error?: unknown } | undefined)?.error;
      const msg = typeof error === 'string' ? error : `erro ${res.status}`;
      if (res.status === 404) setText(this.hint, NOT_FOUND_SKILL_ERROR);
      else if (res.status === 409) setText(this.hint, msg);
      else setText(this.hint, `Não deu: ${msg}`);
      this.hint.classList.add('is-error');
    } catch (err) {
      setText(this.hint, `Não foi possível falar com o Habblaud.`);
      this.hint.classList.add('is-error');
    } finally {
      this.busy = false;
    }
  }

  render(): void {
    this.button.hidden = !this.available();
    if (this.el.open && !this.available()) this.el.close();
    // Se o agente mudou enquanto o painel está aberto, recarrega.
    if (this.el.open) {
      const sel = this.ctx.selection();
      const newAgentId = sel?.type === 'agent' ? sel.id : null;
      if (newAgentId !== this.currentAgentId) {
        this.currentAgentId = newAgentId;
        this.load();
      }
    }
  }
}