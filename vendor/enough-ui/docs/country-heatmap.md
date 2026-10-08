# Country heatmap

`CountryHeatmap` is a responsive world choropleth with the same static presentation in React and native Astro. Its SVG, legend, country labels, color normalization, and expandable data table share a dependency-free data helper. Native HTML expands the table without hydration. React can also render it on the server; the component does not require client state. It does not make hundreds of map shapes keyboard stops or rely on mouse tooltips to expose values.

Use the React `@enoughtools/ui-react/country-heatmap` or Astro `@enoughtools/ui-astro/country-heatmap` entry point. Import the selected package's `styles.css`. React accepts `className`; Astro accepts `class`.

```tsx
import { CountryHeatmap } from '@enoughtools/ui-react/country-heatmap'

<CountryHeatmap
  title="Sessions by country"
  valueLabel="Sessions"
  data={[
    { code: 'US', value: 820 },
    { code: 'NZ', value: 0 },
    { code: 'SG', value: 125 },
    { code: 'IS', value: null },
  ]}
/>
```

```astro
---
import CountryHeatmap from '@enoughtools/ui-astro/country-heatmap';
const data = [{ code: 'US', value: 820 }, { code: 'NZ', value: 0 }];
---
<CountryHeatmap title="Sessions by country" valueLabel="Sessions" {data} />
```

The samples in Storybook use invented values. No customer or analytics data ships with the component.

## Data and scale

- Supply ISO 3166-1 alpha-2 codes. Whitespace and lowercase are normalized; the common `UK` and `EL` aliases map to `GB` and `GR`. Other two-letter identifiers remain in the table even if the map does not recognize them. Non-two-letter identifiers raise a `RangeError`.
- Duplicate normalized codes are added together. A finite observation wins over a missing observation; the first nonempty custom `label` wins. Summing beyond the finite numeric range raises a `RangeError`.
- A measured `0` is a colored observation. Missing countries, `null`, `NaN`, and infinite values receive the distinct no-data fill. An all-zero dataset shows a zero legend; it is not an empty dataset.
- `scale="linear"` is the default. `scale="log"` uses `sign(value) × log(1 + abs(value))`, so zero and negative values remain valid. Five discrete shades run from low to high. This is a sequential scale; choose a specialized diverging chart when a meaningful midpoint needs its own color.
- The default color domain includes zero and all finite observations. Set `domain={[minimum, maximum]}` to compare periods on the same scale. Finite, ascending endpoints are required. Outliers are clamped to the end shades, while the table preserves their original values. A collapsed domain uses one shade without dividing by zero.
- `locale` localizes country names and numbers. `label` overrides an individual country's name. `formatValue` can format percentages, currency, or units; it also formats legend endpoints. The default preserves up to 21 significant digits. Visible title, description, value/country headers, no-data and empty text, table summary, legend label, map-scale note, and log-scale label have string props.
- `tableOpen` initially opens the native details element. The complete table remains present when collapsed, including small countries that are not drawn. The SVG has separate, unique title and description references for each instance. All typography uses the shared proportional font.
- Long numeric and custom-formatted legend labels wrap within the component. The table's named, focusable region scrolls horizontally with a pointer or keyboard when exact values need more room, without widening the page. Storybook includes large/small finite values and a long unbroken custom formatter as responsive fixtures.

## Geometry and provenance

The geometry comes from the world heatmap used by the Webscav reporting template. EnoughUI reuses only the public-domain boundary geometry and the general presentation pattern, with a new neutral API and shared renderer implementation.

The original data is [Natural Earth's 1:110m administrative country dataset](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson). The extraction was retrieved on 17 September 2026 from the [upstream GeoJSON source](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson). The bundled SVG paths use `ISO_A2_EH`, avoiding the `ISO_A2=-99` placeholders for France and Norway. Coordinates use the equirectangular projection `x = (longitude + 180) × 2`, `y = (85 − latitude) × 2`, in `viewBox="0 0 720 300"`. Country polygons are split at the antimeridian upstream. Antarctica is omitted.

The bundled map contains 176 country/region shapes. This low-resolution geometry is a visual approximation, not complete ISO country coverage. Some small countries are absent. Values for absent countries remain in the data table and do not silently become mapped regions. Natural Earth's two unassigned `-99` regions are always no-data and never joined to observations; the component does not infer a sovereign country's values for them. The geometry's display of disputed boundaries follows this particular upstream dataset and extraction.

[Natural Earth's terms](https://www.naturalearthdata.com/about/terms-of-use/) place all its vector and raster map data in the public domain and permit modification and redistribution. Permission and attribution are not required. The component keeps a visible source credit and this provenance record for transparency. The geometry is stored as a TypeScript data module so both renderer artifacts include it without adding a map library, network fetch, or React dependency to native Astro.
