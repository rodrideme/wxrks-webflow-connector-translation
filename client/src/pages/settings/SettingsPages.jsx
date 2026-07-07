import { useEffect, useState } from "react";
import api from "../../services/api.js";
import { formatDateOnly } from "../../formatDate.js";
import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";

const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";

export default function SettingsPages({ settings, markDirty, timezone }) {
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getPages()
      .then((res) => setPages(res.pages || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function isPageEnabled(pageId) {
    return settings.pages.allPagesEnabled || settings.pages.enabledPageIds.includes(pageId);
  }

  function togglePage(pageId) {
    const { pages: pagesSettings } = settings;
    if (pagesSettings.allPagesEnabled) {
      // Materialize: everything was implicitly enabled -- switch to an
      // explicit list of everything except the one just unchecked.
      const allIds = pages.map((p) => p.id);
      markDirty({
        pages: { ...pagesSettings, allPagesEnabled: false, enabledPageIds: allIds.filter((id) => id !== pageId) },
      });
      return;
    }
    const enabledPageIds = pagesSettings.enabledPageIds.includes(pageId)
      ? pagesSettings.enabledPageIds.filter((id) => id !== pageId)
      : [...pagesSettings.enabledPageIds, pageId];
    markDirty({ pages: { ...pagesSettings, enabledPageIds } });
  }

  function checkAll() {
    markDirty({ pages: { ...settings.pages, allPagesEnabled: true, enabledPageIds: [] } });
  }

  function uncheckAll() {
    markDirty({ pages: { ...settings.pages, allPagesEnabled: false, enabledPageIds: [] } });
  }

  if (loading) return <p className="text-sm text-ink-soft">Loading pages...</p>;

  return (
    <div>
      {error && <p className="mb-3 text-sm font-medium text-status-error-fg">Error: {error}</p>}
      {pages.length > 0 && (
        <p className="mb-3 text-sm text-ink-soft">
          <button type="button" className={linkButtonClass} onClick={checkAll}>
            Check all
          </button>{" "}
          ·{" "}
          <button type="button" className={linkButtonClass} onClick={uncheckAll}>
            Uncheck all
          </button>
          {" — manual sync."}
        </p>
      )}
      {pages.length === 0 && <p className="text-sm text-ink-faint">No static pages found.</p>}

      <Card>
        <div className="max-h-[32rem] overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="whitespace-nowrap px-3.5 py-2">Sync</th>
              <th className="whitespace-nowrap px-3 py-2">Page</th>
              <th className="whitespace-nowrap px-3 py-2">Slug</th>
              <th className="whitespace-nowrap px-3 py-2">Last updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pages.map((page) => (
              <tr key={page.id} className="hover:bg-surface-sunken">
                <td className="px-3.5 py-2.5">
                  <Toggle checked={isPageEnabled(page.id)} onChange={() => togglePage(page.id)} label={page.title} />
                </td>
                <td className="px-3 py-2.5 font-medium text-ink">{page.title}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">{page.slug}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">{formatDateOnly(page.lastUpdated, timezone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>
    </div>
  );
}
