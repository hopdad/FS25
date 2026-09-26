import type { FarmState, LiveFarm } from "@farmlink/schema";
import { fillTypeLabel, formatLiters, formatMoney, weatherIcon, weatherLabel } from "../format";

const MAX_STOCKS = 6;

export interface FarmSummaryProps {
  farm: FarmState | null;
  weather: LiveFarm["farm"]["weather"] | null;
}

/** Money, the silos and the weather, from the 60-second farm channel. */
export function FarmSummary({ farm, weather }: FarmSummaryProps) {
  if (!farm && !weather) {
    return (
      <section className="card farm" aria-labelledby="farm-title">
        <h2 id="farm-title">Farm</h2>
        <p className="muted">Farm data arrives once a minute.</p>
      </section>
    );
  }
  const storage = [...(farm?.storage ?? [])]
    .sort((a, b) => b.liters - a.liters)
    .slice(0, MAX_STOCKS);
  return (
    <section className="card farm" aria-labelledby="farm-title">
      <h2 id="farm-title">{farm?.name ?? "Farm"}</h2>
      {farm && (
        <dl className="facts money">
          <div>
            <dt>Balance</dt>
            <dd className={farm.balance < 0 ? "negative" : undefined}>
              {formatMoney(farm.balance)}
            </dd>
          </div>
          <div>
            <dt>Loan</dt>
            <dd>{formatMoney(farm.loan)}</dd>
          </div>
        </dl>
      )}
      {weather?.current && (
        <div className="weather">
          <span className="weather-now">
            <span aria-hidden="true">{weatherIcon(weather.current.type)}</span>{" "}
            {weatherLabel(weather.current.type)}, {Math.round(weather.current.temperatureC)} °C
          </span>
          {weather.forecast.length > 0 && (
            <ol className="forecast">
              {weather.forecast.slice(0, 4).map((day) => (
                <li key={day.day} title={weatherLabel(day.type)}>
                  <span className="muted small">Day {day.day}</span>
                  <span aria-hidden="true">{weatherIcon(day.type)}</span>
                  <span className="small">
                    {Math.round(day.minC)}° / {Math.round(day.maxC)}°
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {storage.length > 0 && (
        <>
          <h3>In storage</h3>
          <ul className="stocks">
            {storage.map((stock) => (
              <li key={stock.fillType}>
                <span>{fillTypeLabel(stock.fillType)}</span>
                <span className="muted">{formatLiters(stock.liters)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
