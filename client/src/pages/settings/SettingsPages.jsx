import { useEffect, useState } from "react";
import api from "../../services/api.js";
import { formatDateOnly } from "../../formatDate.js";

const linkButtonClass = "text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline";

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

  if (loading) return <p className="text-slate-600">Loading pages...</p>;

  return (
    <div>
      {error && <p className="mb-3 text-sm font-medium text-red-600">Error: {error}</p>}
      {pages.length > 0 && (
        <p className="mb-3">
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
      {pages.length === 0 && <p className="text-sm text-slate-500">No static pages found.</p>}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Sync</th>
              <th className="px-3 py-2">Page</th>
              <th className="px-3 py-2">Slug</th>
              <th className="px-3 py-2">Last updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pages.map((page) => (
              <tr key={page.id} className="hover:bg-slate-50">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={isPageEnabled(page.id)}
                    onChange={() => togglePage(page.id)}
                    className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
                  />
                </td>
                <td className="px-3 py-2 text-slate-900">{page.title}</td>
                <td className="px-3 py-2 text-slate-600">{page.slug}</td>
                <td className="px-3 py-2 text-slate-600">{formatDateOnly(page.lastUpdated, timezone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
