"use client"

import * as React from "react"
import { cn } from "../../lib/utils.js"
import {
  countryHeatmapClasses as classes, countryHeatmapDescription,
  countryHeatmapNoDataColor, createCountryHeatmapModel, type CountryHeatmapOptions,
} from "../../lib/country-heatmap.js"

export type { CountryHeatmapDatum, CountryHeatmapOptions } from "../../lib/country-heatmap.js"

export type CountryHeatmapProps = Omit<React.ComponentProps<"figure">, "children" | "title"> & CountryHeatmapOptions

/** Static SVG and a native expandable data table; hydration is optional. */
function CountryHeatmap({
  data, title = "Country heatmap", description = countryHeatmapDescription,
  valueLabel = "Value", countryLabel = "Country", noDataLabel = "No data",
  emptyLabel = "No country data to display", tableLabel = "View country data",
  legendLabel = "Map legend", unmappedLabel = "Not shown at this map scale",
  scaleLabel = "Log scale", locale, formatValue, scale = "linear", domain,
  tableOpen = false, note, className, ...props
}: CountryHeatmapProps) {
  const uniqueId = `country-heatmap-${React.useId()}`
  const model = createCountryHeatmapModel({ data, locale, formatValue, scale, domain, noDataLabel, unmappedLabel })
  return (
    <figure {...props} data-slot="country-heatmap" data-scale={scale} className={cn(classes.root, className)}>
      <figcaption className={classes.caption}>
        <span className={classes.title}>{title}</span>
        <span className={classes.description}>{description}</span>
      </figcaption>
      <svg viewBox="0 0 720 300" role="img" aria-labelledby={`${uniqueId}-title`} aria-describedby={`${uniqueId}-description`} data-slot="country-heatmap-map" className={classes.map}>
        <title id={`${uniqueId}-title`}>{title}</title>
        <desc id={`${uniqueId}-description`}>{description}</desc>
        {model.countries.map((country) => <path key={country.key} data-country={country.code} data-state={country.state} d={country.path} fill={country.color} stroke="var(--color-surface)" strokeWidth="0.7" fillRule="evenodd">
          <title>{`${country.name}: ${country.formattedValue}`}</title>
        </path>)}
      </svg>
      <div role="list" aria-label={legendLabel} data-slot="country-heatmap-legend" className={classes.legend}>
        <span role="listitem" className={classes.legendItem}><span aria-hidden="true" className={classes.swatch} style={{ backgroundColor: countryHeatmapNoDataColor }} />{noDataLabel}</span>
        {model.hasData && <span role="listitem" className={classes.range}>
          {!model.collapsed && <span className={classes.endpoint}>{model.minimumLabel}</span>}
          <span aria-hidden="true" className={model.collapsed ? classes.swatch : classes.ramp}>{model.legendColors.map((color) => <span key={color} className={classes.rampStep} style={{ backgroundColor: color, display: "block" }} />)}</span>
          <span className={classes.endpoint}>{model.maximumLabel} {valueLabel}</span>
          {scale === "log" && <span className={classes.note}>({scaleLabel})</span>}
        </span>}
      </div>
      {!model.hasData && <p data-slot="country-heatmap-empty" className={classes.empty}>{emptyLabel}</p>}
      {note && <p className={classes.note}>{note}</p>}
      <details data-slot="country-heatmap-data" open={tableOpen} className={classes.details}>
        <summary className={classes.summary}>{tableLabel}</summary>
        <div data-slot="country-heatmap-table-scroll" role="region" aria-label={`${title}: ${valueLabel}`} tabIndex={0} className={classes.tableWrapper}>
          <table className={classes.table}>
            <caption className={classes.tableCaption}>{title}: {valueLabel}</caption>
            <thead><tr><th scope="col" className={classes.head}>{countryLabel}</th><th scope="col" className={classes.numberHead}>{valueLabel}</th></tr></thead>
            <tbody>{model.rows.map((row) => <tr key={row.code} data-country={row.code} className={classes.row}>
              <th scope="row" className={classes.country}>{row.label}<span className={classes.code}>{row.code}</span>{!row.mapped && <span className={classes.unmapped}>{unmappedLabel}</span>}</th>
              <td className={classes.value}>{row.formattedValue}</td>
            </tr>)}
            {!model.rows.length && <tr><td colSpan={2} className={classes.country}>{emptyLabel}</td></tr>}
            </tbody>
          </table>
        </div>
      </details>
      <p className={classes.credit}>Boundaries: <a href="https://www.naturalearthdata.com/about/terms-of-use/" className={classes.creditLink}>Natural Earth</a>, 1:110m. Antarctica is omitted; some small countries are visible only in the data table.</p>
    </figure>
  )
}

export { CountryHeatmap }
