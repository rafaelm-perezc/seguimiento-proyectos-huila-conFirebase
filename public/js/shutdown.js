(() => {
    const shutdownButtons = document.querySelectorAll('.btn-shutdown');
    if (!shutdownButtons.length) {
        return;
    }

    const cerrarVentana = () => {
        try {
            window.open('about:blank', '_self');
            window.close();
        } finally {
            setTimeout(() => {
                window.location.replace('about:blank');
                window.close();
            }, 100);
        }
    };

    shutdownButtons.forEach((button) => {
        button.addEventListener('click', async () => {
            try {
                await fetch('/api/shutdown', { method: 'POST' });
            } catch (error) {
                console.error('No se pudo cerrar el servidor.', error);
            } finally {
                cerrarVentana();
            }
        });
    });
})();
