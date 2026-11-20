# Compartir un proyecto en Filigranas

El anfitrión y el invitado se conectan al mismo servicio HTTPS. El anfitrión mantiene Filigranas abierto. La invitación admite un invitado, caduca a los 15 minutos y se consume al usarla. La sesión termina al dejar de compartir, al salir el invitado, al reiniciar el servicio o al alcanzar ocho horas.

El invitado ve los archivos de texto registrados en el índice Git de la copia seleccionada. Para compartir un archivo nuevo, añádelo a Git. El anfitrión elige **Solo lectura** o **Puede editar** al crear la invitación y puede cambiar el permiso mientras comparte. Con edición, el invitado puede guardar archivos existentes de texto UTF-8 de hasta 2 MB. Los archivos sin seguimiento, los enlaces y los submódulos quedan fuera de la vista. Reinicia el servicio con esta versión para habilitar la edición.

Los cambios guardados se reflejan automáticamente en el archivo abierto por la otra persona. Si los dos parten de la misma versión y uno guarda primero, el otro conserva su borrador y puede consultar el contenido guardado. Para integrar tus cambios, revisa la versión actual, elige **Mantener mi borrador sobre esta versión** y ajusta el borrador antes de guardar. Si el archivo vuelve a cambiar mientras lo revisas, Filigranas vuelve a comprobar la versión al guardar.

## Poner el servicio en marcha

Se necesita Node.js 20 o posterior y un servidor accesible por ambas redes. En el servidor, genera una clave de 32 bytes en formato base64url y guárdala como secreto del servicio.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Con `FILIGRANAS_RELAY_KEY` configurada en el entorno, ejecuta `node relay/server.mjs`. Por defecto, escucha en `127.0.0.1:8787`. Publica ese puerto local con un proxy HTTPS en el mismo servidor y un dominio con certificado válido. El proxy debe permitir peticiones de hasta 16 MiB y esperar al menos 25 segundos por respuesta.

El servicio también puede terminar HTTPS directamente si se configuran `TLS_CERT` y `TLS_KEY` con las rutas del certificado y su clave, junto con `HOST` y `PORT`. La configuración sin certificado solo permite escuchar en loopback. El servicio procesa los archivos en memoria mientras los entrega, así que usa un servidor de confianza y evita registrar cuerpos de peticiones en el proxy.

## Abrir una dirección HTTPS de prueba

En macOS, instala `cloudflared` con `brew install cloudflared` si aún no lo tienes. Desde la raíz del repositorio, ejecuta:

```sh
node relay/quick-tunnel.mjs
```

El comando abre el servicio en una dirección HTTPS temporal y muestra la dirección y la clave para el anfitrión. Mantén esa terminal abierta durante la prueba. Al pulsar Ctrl+C se cierra el servicio y la dirección deja de funcionar. Cloudflare opera el túnel temporal, por lo que conviene usar un proyecto de ejemplo. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## Probar desde dos redes

1. En el Filigranas del anfitrión, selecciona un proyecto Git o una sesión con su propia copia de trabajo. Haz clic derecho en el proyecto y selecciona **Compartir proyecto**. A continuación, introduce la dirección HTTPS y la clave del servicio y pulsa **Crear invitación**.
2. En la otra red, abre Filigranas, pulsa **Unirse** junto a **Nuevo proyecto** y pega la invitación. En el primer inicio, la opción es **Unirse a un proyecto**. La clave del servicio solo se pide al anfitrión.
3. Abre el mismo archivo en los dos equipos y cambia el permiso a **Puede editar**. Guarda un cambio desde el invitado y comprueba que aparece en el anfitrión. Escribe en los dos editores y guarda primero desde el anfitrión. En el invitado debe aparecer la versión guardada sin perder su borrador. Repite guardando primero desde el invitado. Vuelve a **Solo lectura** y comprueba que desaparece el botón de guardar.
4. En el Filigranas anfitrión, vuelve a **Compartir proyecto** desde el menú contextual y pulsa **Dejar de compartir**. El acceso se revoca en el servicio y la vista del invitado muestra que la sesión ha terminado.

Para una prueba local que usa el servicio real, Git temporal y el cliente Rust:

```sh
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml share_edit_and_revoke_over_relay -- --ignored
```
