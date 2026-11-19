// sqlx::migrate! embeds migrations at compile time; make sure adding a
// migration file triggers a rebuild of this crate.
fn main() {
    println!("cargo:rerun-if-changed=../../migrations");
    println!("cargo:rerun-if-changed=../../migrations_sqlite");
}
