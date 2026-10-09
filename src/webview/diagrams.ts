import mermaid from 'mermaid';

let seq = 0;

export async function renderDiagrams(container: HTMLElement, onError: (key: string, code: string, error: string) => void): Promise<void> {
  const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  for (const fig of Array.from(container.querySelectorAll<HTMLElement>('figure.diagram:not(.failed)'))) {
    const src = fig.querySelector<HTMLElement>('pre.mermaid-src');
    const out = fig.querySelector<HTMLElement>('.mermaid-out');
    if (!src || !out) continue;
    const code = src.textContent ?? '';
    try {
      await mermaid.parse(code);
      const { svg } = await mermaid.render(`ed-mermaid-${++seq}`, code);
      out.innerHTML = svg;
      src.hidden = true;
      fig.querySelector<HTMLButtonElement>('button.maximize')?.removeAttribute('hidden');
    } catch (e) {
      document.getElementById(`ded-mermaid-${seq}`)?.remove();
      src.hidden = false;
      onError(fig.dataset.key ?? '', code, e instanceof Error ? e.message : String(e));
    }
  }
}
