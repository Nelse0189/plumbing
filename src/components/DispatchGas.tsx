import { useEffect, useMemo, useRef, useState } from 'react';
import type { DispatchPlan, DispatchTruck, FuelSettings, NearbyGasStation, TruckGasEstimate } from '../types';
import { saveFuelSettings, saveTruckMpg, subscribeFuelSettings } from '../services/fuelSettingsService';
import { estimateTrucksGas, fetchNearbyGasStations } from '../services/gasEstimateService';
import { DEFAULT_DISPATCH_ORIGIN_COORDS } from '../utils/dispatchWindows';
import {
  clampMpg,
  clampPrice,
  defaultFuelSettings,
  FALLBACK_GAS_PRICE,
  formatGasUsd,
  isCitgoStation,
  repriceEstimates,
  resolvedGasPrice,
  stationPriceLabel,
  sumFleetGas,
} from '../utils/gasEstimate';
import './DispatchGas.css';

export function useDispatchGas(plan: DispatchPlan | null): {
  settings: FuelSettings;
  estimates: TruckGasEstimate[];
  estimateFor: (truckId: string) => TruckGasEstimate | undefined;
  savingFuel: boolean;
  onShopPrice: (price: number | null) => Promise<void>;
  onSaveFuel: (price: number | null, mpg: number) => Promise<void>;
  onTruckMpg: (truckId: string, mpg: number) => Promise<void>;
} {
  const [settings, setSettings] = useState<FuelSettings>(defaultFuelSettings);
  const [routeEstimates, setRouteEstimates] = useState<TruckGasEstimate[]>([]);
  const [savingFuel, setSavingFuel] = useState(false);
  const settingsRef = useRef(settings);
  const planRef = useRef(plan);
  settingsRef.current = settings;
  planRef.current = plan;

  useEffect(() => {
    return subscribeFuelSettings(setSettings, (error) => {
      console.warn('Fuel settings:', error);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const latest = settingsRef.current;
      const ageMs = Date.now() - Date.parse(latest.placesFetchedAt || '');
      const usingCitgo = isCitgoStation({
        name: latest.placesStationName || '',
        address: '',
      });
      if (
        Number.isFinite(ageMs) &&
        ageMs < 30 * 60 * 1000 &&
        latest.placesPricePerGallon &&
        usingCitgo
      ) {
        return;
      }
      void fetchNearbyGasStations(DEFAULT_DISPATCH_ORIGIN_COORDS).then(async (result) => {
        if (cancelled) return;
        if (result.error || !result.preferred?.pricePerGallon) {
          if (result.error) console.warn('Nearby gas prices:', result.error);
          return;
        }
        const current = settingsRef.current;
        const preferred = result.preferred;
        const sameStations =
          current.placesStationId === preferred.id &&
          current.placesPricePerGallon === preferred.pricePerGallon;
        if (sameStations && (current.placesStations?.length || 0) === result.stations.length) {
          return;
        }
        setSettings(
          await saveFuelSettings({
            ...current,
            pricePerGallon: isCitgoStation(preferred) ? null : current.pricePerGallon,
            placesPricePerGallon: preferred.pricePerGallon,
            placesStationName: stationPriceLabel(preferred),
            placesStationId: preferred.id,
            placesFetchedAt: new Date().toISOString(),
            placesStations: result.stations,
          })
        );
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [plan?.originAddress]);

  const routeSignature = plan
    ? `${plan.originAddress}|${plan.trucks
        .map(
          (truck) =>
            `${truck.id}:${truck.gasReceiptUsd ?? ''}:${truck.stops
              .map((stop) => stop.address || '')
              .join('>')}`
        )
        .join(';')}`
    : '';

  useEffect(() => {
    const currentPlan = planRef.current;
    if (!currentPlan) {
      setRouteEstimates([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void estimateTrucksGas({
        originAddress: currentPlan.originAddress,
        trucks: currentPlan.trucks,
        settings: settingsRef.current,
      }).then(async (result) => {
        if (cancelled) return;
        setRouteEstimates(result.estimates);
        const latest = settingsRef.current;
        if (
          result.eiaPricePerGallon &&
          (latest.eiaPricePerGallon !== result.eiaPricePerGallon ||
            latest.eiaPeriod !== result.eiaPeriod)
        ) {
          setSettings(
            await saveFuelSettings({
              ...latest,
              eiaPricePerGallon: result.eiaPricePerGallon,
              eiaPeriod: result.eiaPeriod,
            })
          );
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [routeSignature]);

  const estimates = useMemo(
    () => repriceEstimates(routeEstimates, settings),
    [routeEstimates, settings]
  );

  const estimateFor = (truckId: string) =>
    estimates.find((item) => item.truckId === truckId);

  const persistFuel = async (next: FuelSettings) => {
    setSettings(next);
    setSavingFuel(true);
    try {
      setSettings(await saveFuelSettings(next));
    } finally {
      setSavingFuel(false);
    }
  };

  const onShopPrice = async (price: number | null) => {
    await persistFuel({
      ...settings,
      pricePerGallon: price && price > 0 ? clampPrice(price) : null,
    });
  };

  const onSaveFuel = async (price: number | null, mpg: number) => {
    await persistFuel({
      ...settings,
      pricePerGallon: price && price > 0 ? clampPrice(price) : null,
      defaultMpg: mpg > 0 ? clampMpg(mpg) : settings.defaultMpg,
    });
  };

  const onTruckMpg = async (truckId: string, mpg: number) => {
    setSavingFuel(true);
    try {
      const next = await saveTruckMpg(settings, truckId, mpg);
      setSettings(next);
    } finally {
      setSavingFuel(false);
    }
  };

  return {
    settings,
    estimates,
    estimateFor,
    savingFuel,
    onShopPrice,
    onSaveFuel,
    onTruckMpg,
  };
}

export function DispatchGasBar({
  estimates,
  settings,
  savingFuel,
  onShopPrice,
  onSaveFuel,
}: {
  estimates: TruckGasEstimate[];
  settings: FuelSettings;
  savingFuel: boolean;
  onShopPrice: (price: number | null) => Promise<void>;
  onSaveFuel: (price: number | null, mpg: number) => Promise<void>;
}) {
  const [priceDraft, setPriceDraft] = useState(
    settings.pricePerGallon != null ? String(settings.pricePerGallon) : ''
  );
  const [mpgDraft, setMpgDraft] = useState(String(settings.defaultMpg));

  useEffect(() => {
    if (settings.pricePerGallon != null) {
      setPriceDraft(String(settings.pricePerGallon));
    } else {
      setPriceDraft((current) =>
        Number(current) === FALLBACK_GAS_PRICE ? '' : current.trim() ? current : ''
      );
    }
    setMpgDraft(String(settings.defaultMpg));
  }, [settings.pricePerGallon, settings.placesPricePerGallon, settings.defaultMpg]);

  const draftPriceValue = Number(priceDraft);
  const draftMpgValue = Number(mpgDraft);
  const draftLooksLikeFallback =
    priceDraft.trim() !== '' && clampPrice(draftPriceValue) === FALLBACK_GAS_PRICE;
  const previewSettings: FuelSettings = {
    ...settings,
    pricePerGallon:
      priceDraft.trim() && draftPriceValue > 0 && !draftLooksLikeFallback
        ? clampPrice(draftPriceValue)
        : settings.pricePerGallon,
    defaultMpg: draftMpgValue > 0 ? clampMpg(draftMpgValue) : settings.defaultMpg,
  };
  const fleet = useMemo(
    () => sumFleetGas(repriceEstimates(estimates, previewSettings)),
    [
      estimates,
      settings,
      priceDraft,
      mpgDraft,
    ]
  );
  const price = resolvedGasPrice(previewSettings);

  const persistDraft = () => {
    const nextPrice =
      priceDraft.trim() && draftPriceValue > 0 && !draftLooksLikeFallback
        ? clampPrice(draftPriceValue)
        : null;
    const nextMpg = draftMpgValue > 0 ? clampMpg(draftMpgValue) : settings.defaultMpg;
    if (nextPrice === settings.pricePerGallon && nextMpg === settings.defaultMpg) {
      return;
    }
    void onSaveFuel(nextPrice, nextMpg);
  };

  const priceLabel =
    price.source === 'manual'
      ? 'shop price'
      : price.source === 'places'
        ? settings.placesStationName || 'nearby pump'
        : price.source === 'eia'
          ? `EIA New England${settings.eiaPeriod ? ` · ${settings.eiaPeriod}` : ''}`
          : 'set shop price';
  const pricedStations = (settings.placesStations || []).filter(
    (station): station is NearbyGasStation & { pricePerGallon: number } =>
      station.pricePerGallon != null && station.pricePerGallon > 0
  );
  const clearPriceLabel = settings.placesPricePerGallon
    ? 'Use pump price'
    : 'Use EIA price';

  return (
    <section className="dispatch-gas" aria-label="Gas budget">
      <div className="dispatch-gas__summary">
        <strong>Gas budget</strong>
        {fleet.trucksWithRoutes > 0 ? (
          <span>
            {fleet.trucksWithRoutes} truck{fleet.trucksWithRoutes === 1 ? '' : 's'} · {fleet.miles}{' '}
            mi · {fleet.gallons} gal · {formatGasUsd(fleet.budgetUsd)} today
          </span>
        ) : (
          <span>Load stops onto trucks to estimate today&apos;s fuel.</span>
        )}
        <span>
          {formatGasUsd(price.pricePerGallon)}/gal ({priceLabel}). Flag a receipt if it is well
          above that truck&apos;s budget and not a full tank (~{formatGasUsd(price.pricePerGallon * settings.tankGallons)}
          ). Paying more than {formatGasUsd(price.pricePerGallon + settings.highPriceDelta)}/gal is
          high for CT.
        </span>
        {pricedStations.length > 0 && (
          <div className="dispatch-gas__stations">
            {pricedStations.map((station) => (
              <button
                key={station.id || station.name}
                type="button"
                className={
                  station.id && station.id === settings.placesStationId
                    ? 'dispatch-gas__station--selected'
                    : undefined
                }
                disabled={savingFuel}
                onClick={() => void onShopPrice(station.pricePerGallon)}
              >
                {stationPriceLabel(station)} {formatGasUsd(station.pricePerGallon)}
                {station.miles > 0 ? ` · ${station.miles} mi` : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      <form
        className="dispatch-gas__settings"
        onSubmit={(event) => {
          event.preventDefault();
          persistDraft();
        }}
      >
        <label>
          $/gal
          <input
            type="number"
            min="1"
            max="9.99"
            step="0.001"
            inputMode="decimal"
            placeholder={price.pricePerGallon.toFixed(2)}
            value={priceDraft}
            disabled={savingFuel}
            onChange={(event) => setPriceDraft(event.target.value)}
            onBlur={persistDraft}
          />
        </label>
        <label>
          Default MPG
          <input
            type="number"
            min="4"
            max="40"
            step="0.1"
            inputMode="decimal"
            value={mpgDraft}
            disabled={savingFuel}
            onChange={(event) => setMpgDraft(event.target.value)}
            onBlur={persistDraft}
          />
        </label>
        <button type="submit" disabled={savingFuel}>
          Save fuel
        </button>
        {settings.pricePerGallon != null && (
          <button
            type="button"
            disabled={savingFuel}
            onClick={() => void onShopPrice(null)}
          >
            {clearPriceLabel}
          </button>
        )}
      </form>
    </section>
  );
}

export function TruckGasLine({
  truck,
  estimate,
  saving,
  onMpg,
  onReceipt,
}: {
  truck: DispatchTruck;
  estimate?: TruckGasEstimate;
  saving: boolean;
  onMpg: (mpg: number) => Promise<void>;
  onReceipt: (amount: number | null) => Promise<void>;
}) {
  const [mpgDraft, setMpgDraft] = useState(estimate ? String(estimate.mpg) : '');
  const [receiptDraft, setReceiptDraft] = useState(
    truck.gasReceiptUsd != null ? String(truck.gasReceiptUsd) : ''
  );

  useEffect(() => {
    if (estimate) setMpgDraft(String(estimate.mpg));
  }, [estimate]);

  useEffect(() => {
    setReceiptDraft(truck.gasReceiptUsd != null ? String(truck.gasReceiptUsd) : '');
  }, [truck.gasReceiptUsd]);

  if (!estimate || estimate.stopCount === 0) {
    return <p className="dispatch-gas-line dispatch-gas-line--empty">No route to estimate yet.</p>;
  }

  const flagClass =
    estimate.receiptFlag === 'high'
      ? ' dispatch-gas-line--high'
      : estimate.receiptFlag === 'fill_up'
        ? ' dispatch-gas-line--fill'
        : estimate.receiptFlag === 'ok'
          ? ' dispatch-gas-line--ok'
          : '';

  const flagText =
    estimate.receiptFlag === 'high'
      ? `Receipt ${formatGasUsd(estimate.receiptUsd || 0)} is high vs a ${formatGasUsd(estimate.budgetUsd)} route.`
      : estimate.receiptFlag === 'fill_up'
        ? `Receipt looks like a fill-up (tank ~${formatGasUsd(estimate.tankFillUsd)}).`
        : estimate.receiptFlag === 'ok'
          ? `Receipt is in range of the ${formatGasUsd(estimate.budgetUsd)} budget.`
          : `${estimate.milesSource === 'haversine' ? 'Approx ' : ''}${estimate.miles} mi · ${estimate.gallons} gal · budget ${formatGasUsd(estimate.budgetUsd)}`;

  return (
    <div className={`dispatch-gas-line${flagClass}`}>
      <p>{flagText}</p>
      <div className="dispatch-gas-line__fields">
        <label>
          MPG
          <input
            type="number"
            min="4"
            max="40"
            step="0.1"
            inputMode="decimal"
            value={mpgDraft}
            disabled={saving}
            onChange={(event) => setMpgDraft(event.target.value)}
            onBlur={() => {
              const mpg = Number(mpgDraft);
              if (mpg > 0 && mpg !== estimate.mpg) void onMpg(mpg);
            }}
          />
        </label>
        <label>
          Receipt $
          <input
            type="number"
            min="0"
            max="300"
            step="0.01"
            inputMode="decimal"
            placeholder="0"
            value={receiptDraft}
            disabled={saving}
            onChange={(event) => setReceiptDraft(event.target.value)}
            onBlur={() => {
              const amount = receiptDraft.trim() ? Number(receiptDraft) : null;
              const next = amount && amount > 0 ? Math.round(amount * 100) / 100 : null;
              if (next !== (truck.gasReceiptUsd ?? null)) void onReceipt(next);
            }}
          />
        </label>
      </div>
    </div>
  );
}
