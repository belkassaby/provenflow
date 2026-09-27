public class Repo {
    static String find(String key) {
        return key.length() > 3 ? key : null;
    }

    static int size() {
        return find("id").length();
    }
}
