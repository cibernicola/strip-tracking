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

Requiere Chrome 110 o superior, o un navegador basado en Chromium equivalente. Probada en Vivaldi.
No está publicada en la Chrome Web Store: se instala cargando la carpeta a mano.

1. **Consigue los archivos.** Clona el repositorio (`git clone https://github.com/cibernicola/strip-tracking.git`)
   o pulsa *Code → Download ZIP* en GitHub y **descomprímelo**: el navegador necesita una carpeta, no el ZIP.
2. **Abre la página de extensiones** de tu navegador:

   | Navegador | Dirección |
   |---|---|
   | Chrome | `chrome://extensions` |
   | Vivaldi | `vivaldi://extensions` |
   | Edge | `edge://extensions` |
   | Brave | `brave://extensions` |

3. Activa el **Modo desarrollador** (interruptor de la página de extensiones, normalmente arriba a la derecha).
4. Pulsa **Cargar descomprimida** y elige la carpeta que contiene `manifest.json`
   (la raíz del repositorio, no una subcarpeta).
5. **Fija el icono** (botón del puzzle de la barra de herramientas → chincheta) para ver la insignia con las URLs
   limpiadas hoy y abrir el popup.

Chrome pedirá el permiso «leer y cambiar tus datos en todos los sitios web»: es necesario para reescribir las URLs
antes de cargar la página. La extensión no hace ninguna petición de red propia.

### Comprobar que funciona

Abre esta dirección:

```
https://httpbin.org/get?utm_source=x&UTM_MEDIUM=y&fbclid=abc&q=hola
```

La página muestra en JSON los parámetros que le llegan al servidor. Si la extensión funciona, solo aparece
`"q": "hola"`, y la insignia del icono suma una URL. Si aparecen todos, recarga la extensión desde la página de
extensiones y vuelve a probar.

### Más pruebas en example.com

`example.com` carga cualquier consulta sin error, así que sirve para ver el efecto directamente en la **barra de
direcciones**: tras cargar, la URL debe aparecer ya limpia.

| # | Abre | Debe quedar |
|---|---|---|
| 1 | `https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=prueba&fbclid=abc123` | `https://example.com/` |
| 2 | `https://example.com/?id=42&gclid=xyz&page=2&igsh=qwerty` | `https://example.com/?id=42&page=2` (se conservan los parámetros que no son de tracking) |
| 3 | `https://example.com/?UTM_SOURCE=x&Utm_Medium=y&utm_campaign=z` | `https://example.com/` (variantes de mayúsculas) |
| 4 | `https://example.com/?q=rust&mc_eid=1&_ga=2.123&si=abc&ref=home` | `https://example.com/?q=rust&ref=home` |
| 5 | `https://www.example.com/?utm_source=x` | `https://www.example.com/` (también con subdominio) |

**Grupo de riesgo** (desactivado por defecto):

`https://example.com/?referrer=/inicio&psc=1&feature=share&utm_source=x`

- Por defecto queda `https://example.com/?referrer=/inicio&psc=1&feature=share`: solo se quita `utm_source`.
- Activa `referrer`, `psc` y `feature` en el popup (*Parámetros de riesgo*) y repite: queda `https://example.com/`.

**Parámetros propios:**

`https://example.com/?mi_param=1&id=7`

- Por defecto no cambia. Añade `mi_param` en *Parámetros propios* y repite: queda `https://example.com/?id=7`.
- Los parámetros propios se eliminan exactamente como los escribes: `MI_PARAM` no se tocaría.

**Excepción por sitio y pausa:**

- En `example.com`, pulsa *No limpiar en este sitio* y vuelve a abrir la prueba 1: la URL se conserva entera.
  La excepción cubre también los subdominios (prueba 5). Pulsa *Volver a limpiar aquí* para quitarla.
- Pon el interruptor en *Pausado*: ninguna prueba cambia la URL y la insignia muestra `OFF`.

Después de las pruebas, el popup suma las URLs y los parámetros eliminados; los que no se limpiaron
(excepciones, pausa o grupos desactivados) no cuentan.

### Actualizar

Si cambias los archivos (con `git pull` o descargando de nuevo), vuelve a la página de extensiones y pulsa
**Recargar** (⟳) en la tarjeta de Strip Tracking. Tus ajustes y estadísticas se conservan.

### Desinstalar

Pulsa **Quitar** en la tarjeta de la extensión. Sus estadísticas y ajustes se borran con ella.

## Cómo funciona

El service worker ([`background.js`](background.js)) mantiene **una única regla dinámica** de redirección cuya lista
`removeParams` se construye con *estándar + riesgo activado + propios*; las excepciones por sitio son reglas `allow`
de mayor prioridad. Una sola regla evita que varias reglas de redirección compitan sobre la misma petición. Las estadísticas agrupan
las variantes de mayúsculas bajo el nombre canónico del catálogo.
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

- Chrome distingue mayúsculas en los nombres de parámetro (comprobado: `UTM_SOURCE` sobrevive a `utm_source`).
  Por eso, para cada parámetro del catálogo se eliminan también las variantes `UPPER`, `Capitalizada` y
  `Title_Case`. Otras combinaciones raras (`uTm_SoUrCe`) no se limpian, y los parámetros propios se eliminan
  exactamente como se escriben.
- Solo se limpia la navegación (documentos y marcos); no se tocan peticiones de recursos ni redirecciones que hagan
  los propios sitios con JavaScript.

## Licencia

[GPL-3.0](LICENSE)
