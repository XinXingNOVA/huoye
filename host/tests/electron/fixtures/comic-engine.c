/* Native integration fixture. All operations use stdout, like a redistributable CLI. */
#include <archive.h>
#include <archive_entry.h>
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <process.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

static int wait_for_cancel(const char *pid_path) {
    FILE *pid_file = fopen(pid_path, "w");
    if (!pid_file) return 1;
#ifdef _WIN32
    fprintf(pid_file, "%d", _getpid());
    fclose(pid_file);
    Sleep(60000);
#else
    fprintf(pid_file, "%ld", (long)getpid());
    fclose(pid_file);
    sleep(60);
#endif
    return 0;
}

static int read_zip(struct archive *zip, const char *path, const char *page) {
    if (archive_read_support_format_zip(zip) != ARCHIVE_OK ||
        archive_read_open_filename(zip, path, 16384) != ARCHIVE_OK) return 1;
    struct archive_entry *entry;
    int status;
    while ((status = archive_read_next_header(zip, &entry)) == ARCHIVE_OK) {
        const char *name = archive_entry_pathname(entry);
        if (!name) return 1;
        if (!page) {
            if (puts(name) == EOF) return 1;
        } else if (strcmp(page, name) == 0) {
            char data[16384];
            la_ssize_t bytes;
            while ((bytes = archive_read_data(zip, data, sizeof(data))) > 0) {
                if (fwrite(data, 1, (size_t)bytes, stdout) != (size_t)bytes) return 1;
            }
            return bytes == 0 ? 0 : 1;
        }
    }
    return !page && status == ARCHIVE_EOF ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "wait") == 0) return wait_for_cancel(argv[2]);
    if (!((argc == 3 && strcmp(argv[1], "list") == 0) ||
          (argc == 4 && strcmp(argv[1], "page") == 0))) return 2;
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    struct archive *zip = archive_read_new();
    if (!zip) return 1;
    int result = read_zip(zip, argv[2], argc == 4 ? argv[3] : NULL);
    if (result && archive_error_string(zip)) fprintf(stderr, "%s\n", archive_error_string(zip));
    archive_read_free(zip);
    return result;
}
