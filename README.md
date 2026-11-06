# Strip Tracking

Extensión de Chrome (Manifest V3) que **elimina los parámetros de tracking de las URLs antes de que cargue la página**
(`utm_*`, `fbclid`, `gclid`, `igsh`, `mc_eid`…). Todo ocurre en local: no hay servidores, ni peticiones de red propias,
ni telemetría.

## Qué hace

- **Limpieza previa a la carga**: usa `declarativeNetRequest`, así que la página nunca llega a ver los parámetros.
  Solo actúa sobre navegaciones GET (documentos y marcos), nunca sobre envíos de formularios.
- **Lista estándar** de 140 parámetros de tracking inequívocos, en [`params.json`](params.json).
- **Grupo de riesgo** (12 parámetros, desactivados por defecto): parecen de tracking pero su nombre también lo usan
  webs para funciones reales (`referrer`, `psc`, `feature`…). Cada uno muestra en el popup por qué no es estándar,
  y se activan uno a uno.
- **Parámetros propios**: añade a mano el nombre de cualquier parámetro que quieras eliminar.
- **Interruptor global** y **excepciones por sitio** (incluyen los subdominios).
- **Estadísticas locales**: URLs y parámetros eliminados, gráfico de 14 días, rankings y actividad reciente.
  Exportables a JSON y CSV (el CSV usa `;` y BOM para abrirse bien en Excel en español).

## Privacidad

Solo se guardan **nombres de parámetro y hostname**, en `chrome.storage.local`. Nunca valores ni URLs completas.
Nada sale del navegador. Puedes borrar las estadísticas desde el popup (botón *Reiniciar*).

## Instalación (modo desarrollador)

1. Descarga o clona este repositorio.
2. Abre `chrome://extensions` y activa **Modo desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta del repo.

Requiere Chrome 110 o superior.

## Cómo funciona

El service worker ([`background.js`](background.js)) mantiene **una única regla dinámica** de redirección cuya lista
`removeParams` se construye con *estándar + riesgo activado + propios*; las excepciones por sitio son reglas `allow`
de mayor prioridad. Una sola regla evita que varias reglas de redirección compitan sobre la misma petición.
Las estadísticas se calculan con `webNavigation.onBeforeNavigate` sobre la URL original y cuentan solo lo que se está
eliminando de verdad. El código común (ajustes, catálogo) está en [`shared.js`](shared.js).

| Archivo | Función |
|---|---|
| `manifest.json` | Manifest V3 |
| `params.json` | Catálogo: `standard` y `risk` (con el motivo de cada uno) |
| `background.js` | Reglas, estadísticas, insignia |
| `shared.js` | Ajustes y utilidades comunes |
| `popup.*` | Interfaz |
| `test/` | Pruebas con un `chrome` simulado |
| `tools/` | Generador de iconos y empaquetado |

## Desarrollo

```bash
npm test        # pruebas del service worker con un chrome simulado (sin dependencias)
npm run pack    # genera strip-tracking.zip solo con los archivos de la extensión
```

Para añadir un parámetro al catálogo, edita `params.json`: en `standard` si es tracking inequívoco, o en `risk`
(con su `reason`) si puede tener usos legítimos.

## Limitaciones conocidas

- No se ha verificado si Chrome distingue mayúsculas en los nombres de parámetro, así que `UTM_SOURCE` en mayúsculas
  podría no limpiarse.
- Solo se limpia la navegación (documentos y marcos); no se tocan peticiones de recursos ni redirecciones que hagan
  los propios sitios con JavaScript.

## Licencia

[GPL-3.0](LICENSE)
