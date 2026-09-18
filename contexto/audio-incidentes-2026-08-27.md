# Audio WhatsApp — 27/08/2026 9:52 AM

Nota de voz recibida en el hilo donde se reporta que el gestor marcaba 7 de 10
notificaciones. Explica qué son los incidentes y por qué el matcheo fallaba.

Audio original de 44.9s, transcripto con faster-whisper (modelo `small`, es, local).
El archivo de audio no se publica: es la voz de una persona real.

---

> Dale, dale, buenísimo. Sí, era una cuestión que no la había advertido. Y por ahí
> muchas veces se van generando estos... son **incidentes**, que son como pequeños
> expedientes por algunas cuestiones específicas que se han planteado dentro de ese
> expediente, y las separan y van generando esto así: **Q1, Q2, Q3**, para no detener
> la marcha del otro expediente principal. Pero siempre está vinculada al expediente
> principal y tiene como **número madre el número del expediente principal**. Así que
> habría que ver, si no me voy a empezar a comer todas esas cuestiones y no voy a
> estar siguiendo las notificaciones.

---

## Reglas de negocio que se desprenden

1. Un **incidente** es un expediente chico y separado, abierto por una cuestión
   puntual dentro de un expediente principal, para no frenar la marcha de éste.
2. Se numeran `<número madre>-Q1`, `-Q2`, `-Q3`, … Puede haber varios por principal.
3. El incidente **siempre queda vinculado al principal** y hereda su número madre,
   por lo tanto hereda también su responsable.
4. Notifican por separado: cada incidente genera sus propias notificaciones en el
   casillero, con sus propios plazos.

## Impacto

El riesgo real no es una fila faltante: son **plazos procesales que vencen sin que
nadie los vea**. El modo de falla era silencioso — la fila entraba a la hoja con
`Resp.` vacía y desaparecía de los contadores y de todas las etapas posteriores.

## Fix aplicado

`buscarResponsable()` + `expteBase()` en `Codigo.gs` (commit 6b658db): si el expte
no está en el mapa de `Responsables`, se reintenta con el número madre.
`repararResponsables()` rellena las filas ya escritas.

## Pendiente

¿La API de SAE (`/api/proceedings?number=...`) resuelve el procID de un incidente
con el sufijo `-Q1`, o hay que buscar por número madre y elegir el registro del
incidente? El procID tiene que ser el del incidente, no el del principal.
