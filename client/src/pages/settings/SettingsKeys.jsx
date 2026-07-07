import Card from "../../components/Card.jsx";

export default function SettingsKeys({ settings }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Connection (env-configured)</h2>
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-border">
          {Object.entries(settings.env).map(([key, value]) => (
            <tr key={key}>
              <td className="py-1.5 pr-4 font-mono text-xs text-ink-faint">{key}</td>
              <td className="py-1.5 font-mono text-xs text-ink">
                {value || <em className="text-ink-faint">not set</em>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-ink-faint">
        These are configured via environment variables on Render and are read-only here.
      </p>
    </Card>
  );
}
