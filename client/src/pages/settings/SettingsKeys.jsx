export default function SettingsKeys({ settings }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-slate-900">Connection (env-configured)</h2>
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-slate-100">
          {Object.entries(settings.env).map(([key, value]) => (
            <tr key={key}>
              <td className="py-1.5 pr-4 font-mono text-xs text-slate-500">{key}</td>
              <td className="py-1.5 font-mono text-xs text-slate-800">
                {value || <em className="text-slate-400">not set</em>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-slate-500">
        These are configured via environment variables on Render and are read-only here.
      </p>
    </section>
  );
}
