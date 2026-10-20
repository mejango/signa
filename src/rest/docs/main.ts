for (const button of document.querySelectorAll<HTMLButtonElement>(".copy-code")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const code = button.parentElement?.querySelector("code")?.textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "Copied";
      const status = document.getElementById("copy-status");
      if (status) status.textContent = "Code copied to clipboard.";
      setTimeout(() => { button.textContent = "Copy"; }, 2000);
    } catch {
      button.textContent = "Select code to copy";
      button.parentElement?.querySelector("pre")?.focus();
    }
  });
}
// An opened endpoint replaces its link with the tables from its reference page; the link stays on failure.
document.addEventListener("toggle", async event => {
  const endpoint = event.target;
  if (!(endpoint instanceof HTMLDetailsElement) || !endpoint.open || !endpoint.matches(".endpoint")) return;
  const fields = endpoint.querySelector<HTMLElement>(":scope > .endpoint-fields");
  const link = fields?.querySelector<HTMLAnchorElement>(":scope > p > a");
  if (!fields || !link || fields.dataset.state) return;
  fields.dataset.state = "loading";
  try {
    const response = await fetch(link.href);
    if (!response.ok) throw new Error(String(response.status));
    const loaded = new DOMParser().parseFromString(await response.text(), "text/html").querySelector(".endpoint-fields");
    if (!loaded) throw new Error("missing");
    fields.replaceChildren(...Array.from(loaded.childNodes, node => document.importNode(node, true)));
    fields.dataset.state = "loaded";
  } catch {
    delete fields.dataset.state;
  }
}, true);

const filter = document.querySelector<HTMLInputElement>("#endpoint-filter");
// Field names come from a separate index, fetched the first time the filter is used; a failed fetch retries on the next use.
let terms: Record<string, string> = {};
let termsLoading: Promise<void> | undefined;
const loadTerms = () => termsLoading ??= fetch(filter!.dataset.terms!)
  .then(response => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
  .then(loaded => { terms = loaded; applyFilter(); }, () => { termsLoading = undefined; });
filter?.addEventListener("focus", () => void loadTerms());
filter?.addEventListener("input", () => { applyFilter(); void loadTerms(); });
function applyFilter() {
  if (!filter) return;
  const term = filter.value.trim().toLowerCase();
  let count = 0;
  for (const endpoint of document.querySelectorAll<HTMLDetailsElement>(".endpoint")) {
    // Match the endpoint's own text and field names, not whichever details tables happen to be loaded.
    const text = Array.from(endpoint.children, child => child.matches(".endpoint-fields") ? "" : child.textContent).join(" ");
    endpoint.hidden = !`${text} ${terms[endpoint.dataset.operation ?? ""] ?? ""}`.toLowerCase().includes(term);
    if (!endpoint.hidden) count++;
  }
  for (const group of document.querySelectorAll<HTMLDetailsElement>(".reference > details")) {
    group.hidden = !group.querySelector(".endpoint:not([hidden])");
    if (term && !group.hidden) group.open = true;
  }
  const result = document.getElementById("endpoint-count");
  if (result) result.textContent = `${count} endpoints`;
}
