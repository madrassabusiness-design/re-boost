<?php
// GET api/plans.php — formules et prix affichés sur le site
require __DIR__ . '/boot.php';
require_method('GET');

$list = [];
foreach (plans() as $id => $plan) {
    $list[] = [
        'id'     => $id,
        'name'   => $plan['name'],
        'months' => (int) $plan['months'],
        'price'  => money($plan['price']),
    ];
}

json_response(['currency' => cfg()['currency'], 'plans' => $list]);
