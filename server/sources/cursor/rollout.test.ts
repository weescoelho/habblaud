// Normalização dos eventos de hook do Cursor, tradução de ferramenta e o mapa hook→status. 1:1 aos ACs de T4
// (CPOC-02, CPOC-10) e aos edge cases de `workspace_roots`/aliases defensivos da spec.
import { describe, expect, it } from 'vitest';
import { describeCommand, describeTool } from '../../../shared/activity';
import { describeCursorTool, parseCursorEvent, statusBorder } from './rollout';

describe('parseCursorEvent', () => {
  it('normaliza o evento completo', () => {
    expect(
      parseCursorEvent({
        hook_event_name: 'sessionStart',
        conversation_id: 'conv-1',
        workspace_roots: ['/projetos/demo'],
        cwd: '/projetos/demo',
        tool_name: 'Shell',
        tool_input: { command: 'ls' },
        command: 'ls',
        transcript_path: '/tmp/t.jsonl',
      }),
    ).toEqual({
      name: 'sessionStart',
      conversationId: 'conv-1',
      workspaceRoot: '/projetos/demo',
      cwd: '/projetos/demo',
      toolName: 'Shell',
      toolInput: { command: 'ls' },
      command: 'ls',
      transcriptPath: '/tmp/t.jsonl',
    });
  });

  it('sem hook_event_name → undefined (sem lançar)', () => {
    expect(parseCursorEvent({})).toBeUndefined();
    expect(parseCursorEvent({ conversation_id: 'c' })).toBeUndefined();
  });

  it('campos ausentes viram undefined', () => {
    const ev = parseCursorEvent({ hook_event_name: 'stop' });
    expect(ev).toEqual({ name: 'stop' });
    expect(ev?.conversationId).toBeUndefined();
    expect(ev?.workspaceRoot).toBeUndefined();
    expect(ev?.cwd).toBeUndefined();
    expect(ev?.transcriptPath).toBeUndefined();
  });

  it('lê aliases defensivos (camelCase, workspace, cmd, transcriptPath)', () => {
    expect(
      parseCursorEvent({
        hook_event_name: 'preToolUse',
        conversationId: 'conv-2',
        workspace: '/w',
        toolName: 'Read',
        toolInput: { path: 'a.ts' },
        cmd: 'cat a.ts',
        transcriptPath: '/t/x.jsonl',
        workspace_roots: ['/raiz'],
      }),
    ).toEqual({
      name: 'preToolUse',
      conversationId: 'conv-2',
      workspaceRoot: '/raiz',
      cwd: '/w',
      toolName: 'Read',
      toolInput: { path: 'a.ts' },
      command: 'cat a.ts',
      transcriptPath: '/t/x.jsonl',
    });
  });

  it('workspace_root (singular) quando não há workspace_roots', () => {
    const ev = parseCursorEvent({ hook_event_name: 'sessionStart', conversation_id: 'c', workspace_root: '/solo' });
    expect(ev?.workspaceRoot).toBe('/solo');
  });

  it('session_id como fallback do conversation_id', () => {
    expect(parseCursorEvent({ hook_event_name: 'stop', session_id: 'sess-9' })?.conversationId).toBe('sess-9');
  });
});

describe('describeCursorTool', () => {
  it('Shell → describeCommand (tool Bash)', () => {
    const input = { command: 'ls -la' };
    expect(describeCursorTool('Shell', input)).toEqual({ desc: describeCommand('ls -la'), tool: 'Bash' });
  });

  it('Read/Write/Grep/Glob/WebSearch/Task → describeTool', () => {
    for (const input of [{ file_path: '/a/b.ts' }, { pattern: 'foo' }, { query: 'vitest' }, { description: 'x', prompt: 'y' }]) {
      for (const name of ['Read', 'Write', 'Grep', 'Glob', 'WebSearch', 'Task']) {
        expect(describeCursorTool(name, input)).toEqual({ desc: describeTool(name, input), tool: name });
      }
    }
  });

  it('MCP:<tool> → mcp__<tool>', () => {
    expect(describeCursorTool('MCP:foo_bar', {}).tool).toBe('mcp__foo_bar');
  });

  it('StrReplace (transcript) → describeTool Edit, mantendo o nome cru', () => {
    const input = { path: '/p/a.ts', old_string: 'a', new_string: 'b' };
    expect(describeCursorTool('StrReplace', input)).toEqual({ desc: describeTool('Edit', input), tool: 'StrReplace' });
  });

  it('Glob do transcript usa glob_pattern (aliases) e cita o padrão', () => {
    const { desc, tool } = describeCursorTool('Glob', { glob_pattern: '**/*.ts' });
    expect(tool).toBe('Glob');
    expect(desc.kind).toBe('search');
    expect(desc.text).toContain('**/*.ts');
  });

  it('CallDynamicTool (transcript) → mcp__<namespace>__<toolName>', () => {
    const r = describeCursorTool('CallDynamicTool', { namespace: 'cursor', toolName: 'list_repositories', arguments: { limit: 10 } });
    expect(r.tool).toBe('mcp__cursor__list_repositories');
    expect(r.desc.kind).toBe('mcp');
  });

  it('glob_pattern não sobrescreve um pattern explícito', () => {
    expect(describeCursorTool('Glob', { pattern: 'a.ts', glob_pattern: 'b.ts' }).desc.detail).toBe('a.ts');
  });

  it('ferramenta desconhecida passa pelo describeTool', () => {
    expect(describeCursorTool('Magic', {})).toEqual({ desc: describeTool('Magic', {}), tool: 'Magic' });
  });
});

describe('statusBorder', () => {
  it('mapeia os eventos tratados', () => {
    expect(statusBorder('sessionStart')).toEqual({ status: 'idle' });
    expect(statusBorder('stop')).toEqual({ status: 'idle' });
    expect(statusBorder('beforeSubmitPrompt')).toEqual({ status: 'working' });
    expect(statusBorder('preToolUse')).toEqual({ status: 'working' });
    expect(statusBorder('postToolUse')).toEqual({ status: 'working' });
    expect(statusBorder('postToolUseFailure')).toEqual({ status: 'working' });
    expect(statusBorder('beforeMCPExecution')).toEqual({ status: 'working' });
    expect(statusBorder('afterMCPExecution')).toEqual({ status: 'working' });
    expect(statusBorder('beforeReadFile')).toEqual({ status: 'working' });
    expect(statusBorder('afterFileEdit')).toEqual({ status: 'working' });
    expect(statusBorder('afterAgentResponse')).toEqual({ status: 'working' });
    expect(statusBorder('afterAgentThought')).toEqual({ status: 'working' });
    expect(statusBorder('beforeShellExecution')).toEqual({ status: 'shell' });
    expect(statusBorder('afterShellExecution')).toEqual({ status: 'working' });
  });

  it('desconhecidos (inclui sessionEnd) → undefined', () => {
    expect(statusBorder('sessionEnd')).toBeUndefined();
    expect(statusBorder('qualquer')).toBeUndefined();
  });
});
